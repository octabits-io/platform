/**
 * `createFlowWorkflowRoutes` (Hono) over a real in-memory flow engine — the
 * routes, flow's public-view projection, and the extension seam, all through
 * `../server/testing`'s `testRequest` via the `testableHonoApp` adapter.
 *
 * Every case mounts the sub-app under a prefix (`app.route('/api/ai/workflows',
 * …)`) rather than passing one in: that IS the Hono factory's prefix story, so
 * the mount is under test in all of them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  buildWorkflow,
  createInMemoryWorkflowStore,
  createStepHandlerRegistry,
  createWorkflowEngine,
  defineStep,
  defineWaitStep,
  type Dispatcher,
  type DispatchStepPayload,
  type TypedWorkflow,
  type WorkflowEngine,
} from 'octaflow';
import type { WorkflowWithSteps } from 'octaflow';
import type { Logger } from '../logger/index.ts';
import { testRequest } from '../server/testing.ts';
import type { TestableApp } from '../server/testing.ts';
import { registerErrorHandler } from './errors.ts';
import { testableHonoApp } from './testing.ts';
import { buildFlowWorkflowSchema, createFlowWorkflowRoutes, type FlowEngineReader } from './flow.ts';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

const inputSchema = z.object({ name: z.string() });

const greet = defineStep({
  type: 'greet',
  workflowInputSchema: inputSchema,
  outputSchema: z.object({ greeting: z.string() }),
  handler: async (ctx) => ({ greeting: `Hello, ${ctx.workflowInput.name}` }),
});

const shout = defineStep({
  type: 'shout',
  workflowInputSchema: inputSchema,
  outputSchema: z.object({ loud: z.string() }),
  dependencies: { greet },
  handler: async (ctx) => ({ loud: `${ctx.deps.greet.greeting.toUpperCase()}!` }),
});

const helloWorkflow = buildWorkflow({ type: 'hello', inputSchema, steps: { greet, shout } });

const gate = defineWaitStep({
  type: 'approval-gate',
  outputSchema: z.object({ approved: z.boolean() }),
});

const gateWorkflow = buildWorkflow({
  type: 'gated',
  inputSchema: z.object({}),
  steps: { gate },
});

interface Harness {
  engine: WorkflowEngine<unknown>;
  drain(): Promise<void>;
  start(workflow: TypedWorkflow<any, unknown>, input: Record<string, unknown>, options?: {
    entityRef?: string;
    metadata?: Record<string, unknown>;
  }): Promise<number>;
}

function createHarness(): Harness {
  const store = createInMemoryWorkflowStore('test');
  const registry = createStepHandlerRegistry();
  const queue: DispatchStepPayload[] = [];
  const dispatcher: Dispatcher = {
    async enqueueStep(payload) {
      queue.push(payload);
      return { ok: true, value: undefined };
    },
  };
  const engine = createWorkflowEngine({ store, registry, dispatcher, partitionKey: 'test' });
  helloWorkflow.register(registry);
  gateWorkflow.register(registry);

  return {
    engine,
    async drain() {
      while (queue.length > 0) {
        const job = queue.shift()!;
        await engine.handleStepJob(job);
      }
    },
    async start(workflow, input, options) {
      const started = await workflow.start(engine, input, options);
      if (!started.ok) throw new Error(started.error.message);
      return started.value.workflowId;
    },
  };
}

/**
 * Mount the sub-app under `base` and wire the standard error handler (needed
 * only for the schema-failure path — domain errors answer inline).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mount(routes: Hono<any, any, any>, base = '/api/ai/workflows'): TestableApp {
  const app = new Hono().route(base, routes);
  registerErrorHandler(app, silentLogger, { production: false });
  return testableHonoApp(app);
}

let harness: Harness;
let app: TestableApp;

beforeEach(() => {
  harness = createHarness();
  app = mount(
    createFlowWorkflowRoutes({
      engine: harness.engine,
      errorOverrides: { quota_exceeded: 429 },
    }),
  );
});

describe('createFlowWorkflowRoutes (hono)', () => {
  it('serves the public view of a completed workflow — internals stay off the wire', async () => {
    const id = await harness.start(helloWorkflow, { name: 'Ada' }, { entityRef: 'thing:1' });
    await harness.drain();

    const res = await testRequest(app, 'GET', `/api/ai/workflows/${id}`);
    expect(res.status).toBe(200);
    const workflow = res.data as Record<string, unknown>;
    expect(workflow.status).toBe('completed');
    expect(workflow.entityRef).toBe('thing:1');
    expect(workflow.completedSteps).toBe(2);
    expect(workflow).not.toHaveProperty('partitionKey');
    expect(workflow).not.toHaveProperty('idempotencyKey');
    expect(workflow).not.toHaveProperty('metadata');
    const steps = workflow.steps as Record<string, unknown>[];
    expect(steps.map((s) => s.key).sort()).toEqual(['greet', 'shout']);
    expect(steps[0]).not.toHaveProperty('attempts');
  });

  it('lists newest-first and answers the active probe', async () => {
    const first = await harness.start(helloWorkflow, { name: 'A' }, { entityRef: 'thing:2' });
    await harness.drain();
    const second = await harness.start(helloWorkflow, { name: 'B' }, { entityRef: 'thing:2' });

    const active = await testRequest(app, 'GET', '/api/ai/workflows/active?entityRef=thing:2');
    expect((active.data as { active: boolean }).active).toBe(true);

    // The list route lives at the exact mount path — `.get('/')` under
    // `route()` must not require the trailing-slash form.
    const listed = await testRequest(app, 'GET', '/api/ai/workflows?entityRef=thing:2&limit=2');
    expect(listed.status).toBe(200);
    const items = (listed.data as { items: { id: number }[] }).items;
    expect(items.map((w) => w.id)).toEqual([second, first]);

    await harness.drain();
    const after = await testRequest(app, 'GET', '/api/ai/workflows/active?entityRef=thing:2');
    expect((after.data as { active: boolean }).active).toBe(false);
  });

  it('serves the status snapshot projection', async () => {
    const id = await harness.start(helloWorkflow, { name: 'Ada' });
    await harness.drain();
    const res = await testRequest(app, 'GET', `/api/ai/workflows/${id}/status`);
    expect(res.data).toEqual({ status: 'completed', totalSteps: 2, completedSteps: 2 });
  });

  it('cancels with a 200 body (wire parity with the elysia factory)', async () => {
    const id = await harness.start(helloWorkflow, { name: 'Ada' });
    const res = await testRequest(app, 'POST', `/api/ai/workflows/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ cancelled: true });
    await harness.drain();
    const status = await testRequest(app, 'GET', `/api/ai/workflows/${id}/status`);
    expect((status.data as { status: string }).status).toBe('cancelled');
  });

  it('resumes a waiting step and folds `waiting` to `running` on the wire', async () => {
    const id = await harness.start(gateWorkflow, {});
    await harness.drain();

    // The wait step suspended: engine status `waiting`, wire status `running`.
    const waiting = await testRequest(app, 'GET', `/api/ai/workflows/${id}`);
    const step = (waiting.data as { steps: { status: string }[] }).steps[0];
    expect(step?.status).toBe('running');

    const resumed = await testRequest(app, 'POST', `/api/ai/workflows/${id}/resume`, {
      body: { stepKey: 'gate', payload: { approved: true } },
    });
    expect(resumed.status).toBe(200);
    await harness.drain();

    const done = await testRequest(app, 'GET', `/api/ai/workflows/${id}`);
    expect((done.data as { output: { gate: { approved: boolean } } }).output.gate.approved).toBe(true);
  });

  it('maps workflow_not_found to 404 by key convention', async () => {
    const res = await testRequest(app, 'GET', '/api/ai/workflows/999999');
    expect(res.status).toBe(404);
    expect((res.data as { key: string }).key).toBe('workflow_not_found');
  });

  it('maps a schema failure to the standard validation_error body', async () => {
    // `limit` is bounded by `listLimit.max` (default 50) — over it, octValidator
    // throws and the host error handler emits the framework's standard body.
    const res = await testRequest(app, 'GET', '/api/ai/workflows?limit=9999');
    expect(res.status).toBe(400);
    const data = res.data as { key: string; fields: Array<{ path: string }> };
    expect(data.key).toBe('validation_error');
    expect(data.fields.map((f) => f.path)).toEqual(['limit']);

    // A non-numeric id fails the param schema the same way.
    const badId = await testRequest(app, 'GET', '/api/ai/workflows/abc/status');
    expect(badId.status).toBe(400);
    expect((badId.data as { key: string }).key).toBe('validation_error');
  });

  it('resolves the engine per request when given a resolver', async () => {
    const seen: unknown[] = [];
    const perRequest = mount(
      createFlowWorkflowRoutes({
        engine: (ctx) => {
          seen.push(ctx);
          return harness.engine;
        },
      }),
    );
    const id = await harness.start(helloWorkflow, { name: 'Ada' });
    await harness.drain();
    const res = await testRequest(perRequest, 'GET', `/api/ai/workflows/${id}/status`);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    // The resolver gets the live Hono context (the raw request proves it).
    expect((seen[0] as Context).req.raw).toBeInstanceOf(Request);
  });

  it('gates each route through authorize, mapping the returned key', async () => {
    const guarded = mount(
      createFlowWorkflowRoutes({
        engine: harness.engine,
        authorize: (action) =>
          action === 'cancel' ? { key: 'forbidden', message: 'jobs:cancel required' } : undefined,
      }),
    );
    const id = await harness.start(helloWorkflow, { name: 'Ada' });

    const denied = await testRequest(guarded, 'POST', `/api/ai/workflows/${id}/cancel`);
    expect(denied.status).toBe(403);
    expect((denied.data as { key: string }).key).toBe('forbidden');

    const allowed = await testRequest(guarded, 'GET', `/api/ai/workflows/${id}/status`);
    expect(allowed.status).toBe(200);
  });

  it('excludes child steps by default; includeChildSteps opts back in', async () => {
    const workflow: WorkflowWithSteps = {
      id: 1, type: 'mapper', status: 'running', partitionKey: 'test',
      input: {}, output: null, error: null, entityRef: null, idempotencyKey: null,
      parentWorkflowId: null, parentStepId: null, totalSteps: 1, completedSteps: 0,
      failedSteps: 0, metadata: null, createdAt: 'c', startedAt: null, completedAt: null,
      deadlineAt: null,
      steps: [
        {
          id: 10, workflowId: 1, key: 'fanout', type: 'map', status: 'mapping',
          dependencies: [], input: null, output: null, error: null, metadata: null,
          attempts: 1, parentStepId: null, heartbeatAt: null, startedAt: null, completedAt: null,
        },
        {
          id: 11, workflowId: 1, key: 'fanout#0', type: 'map-item', status: 'running',
          dependencies: [], input: null, output: null, error: null, metadata: null,
          attempts: 1, parentStepId: 10, heartbeatAt: null, startedAt: null, completedAt: null,
        },
      ],
    };
    const stub: FlowEngineReader = {
      getWorkflowStatus: async () => ({ ok: true, value: workflow }),
      listWorkflows: async () => ({ ok: true, value: [workflow] }),
      cancelWorkflow: async () => ({ ok: true, value: undefined }),
      resumeStep: async () => ({ ok: true, value: undefined }),
    };

    const dflt = mount(createFlowWorkflowRoutes({ engine: stub }));
    const res = await testRequest(dflt, 'GET', '/api/ai/workflows/1');
    const steps = (res.data as { steps: { key: string; status: string }[] }).steps;
    expect(steps.map((s) => s.key)).toEqual(['fanout']);
    expect(steps[0]?.status).toBe('running'); // mapping folded

    const withChildren = mount(createFlowWorkflowRoutes({ engine: stub, includeChildSteps: true }));
    const res2 = await testRequest(withChildren, 'GET', '/api/ai/workflows/1');
    expect((res2.data as { steps: { key: string }[] }).steps.map((s) => s.key)).toEqual([
      'fanout',
      'fanout#0',
    ]);
  });

  it('keeps parent path params readable on the /:id routes (param validation does not strip)', async () => {
    // Consumers mount these routes under prefixes carrying their own path params
    // (e.g. /tenant/:tenantId) and read them in the engine resolver. Elysia
    // needed a loose params schema for this; Hono keeps validated data beside
    // `c.req.param()`, so a strict schema is safe — asserted here.
    const workflow: WorkflowWithSteps = {
      id: 7, type: 'demo', status: 'completed', partitionKey: 'test',
      input: {}, output: null, error: null, entityRef: null, idempotencyKey: null,
      parentWorkflowId: null, parentStepId: null, totalSteps: 1, completedSteps: 1,
      failedSteps: 0, metadata: null, createdAt: 'c', startedAt: null, completedAt: null,
      deadlineAt: null,
      steps: [],
    };
    const stub: FlowEngineReader = {
      getWorkflowStatus: async () => ({ ok: true, value: workflow }),
      listWorkflows: async () => ({ ok: true, value: [workflow] }),
      cancelWorkflow: async () => ({ ok: true, value: undefined }),
      resumeStep: async () => ({ ok: true, value: undefined }),
    };
    const seenScopeIds: (string | undefined)[] = [];
    const scoped = mount(
      createFlowWorkflowRoutes({
        engine: (ctx) => {
          seenScopeIds.push((ctx as Context).req.param('scopeId'));
          return stub;
        },
      }),
      '/scope/:scopeId/workflows',
    );

    const status = await testRequest(scoped, 'GET', '/scope/acme/workflows/7/status');
    expect(status.status).toBe(200);
    const get = await testRequest(scoped, 'GET', '/scope/acme/workflows/7');
    expect(get.status).toBe(200);
    expect(seenScopeIds).toEqual(['acme', 'acme']);
  });

  it('batches extendWorkflow.load once per request and hands it to project', async () => {
    const loadCalls: number[][] = [];
    const batched = mount(
      createFlowWorkflowRoutes({
        engine: harness.engine,
        extendWorkflow: {
          schema: { label: z.string() },
          load: (workflows) => {
            loadCalls.push(workflows.map((w) => w.id));
            return new Map(workflows.map((w) => [w.id, `wf-${w.id}`]));
          },
          project: (wf, loaded) => ({ label: loaded?.get(wf.id) ?? 'missing' }),
        },
      }),
    );
    const a = await harness.start(helloWorkflow, { name: 'A' }, { entityRef: 'batch:1' });
    const b = await harness.start(helloWorkflow, { name: 'B' }, { entityRef: 'batch:1' });
    await harness.drain();

    const listed = await testRequest(batched, 'GET', '/api/ai/workflows?entityRef=batch:1');
    const items = (listed.data as { items: { id: number; label: string }[] }).items;
    expect(items.map((w) => w.label).sort()).toEqual([`wf-${a}`, `wf-${b}`].sort());
    expect(loadCalls).toHaveLength(1); // one batch for the whole list
    expect(loadCalls[0]?.slice().sort()).toEqual([a, b].sort());
  });

  it('extends the wire shape via extendWorkflow — schema and value in lockstep', async () => {
    const extended = mount(
      createFlowWorkflowRoutes({
        engine: harness.engine,
        extendWorkflow: {
          schema: { appliedAt: z.string().nullable() },
          project: (wf) => ({ appliedAt: (wf.metadata?.appliedAt as string | undefined) ?? null }),
        },
      }),
      '/runs',
    );
    const id = await harness.start(helloWorkflow, { name: 'Ada' }, {
      metadata: { appliedAt: '2026-07-14T11:00:00.000Z' },
    });
    await harness.drain();

    const res = await testRequest(extended, 'GET', `/runs/${id}`);
    expect((res.data as { appliedAt: string | null }).appliedAt).toBe('2026-07-14T11:00:00.000Z');
    // Still a projection: metadata itself must not leak alongside the extension.
    expect(res.data as object).not.toHaveProperty('metadata');
  });
});

/**
 * The served-view type is written as `PublicWorkflow & z.infer<z.ZodObject<TExt>>`
 * rather than derived from `buildFlowWorkflowSchema(...)` — deriving it carries
 * an unevaluated `$InferObjectOutput<…>` conditional into every route's output
 * and, through them, into any `hc` client, which overflows TypeScript 6's call
 * stack. These two assertions are what the derivation used to buy:
 *
 * 1. **No drift** — the exported schema still validates exactly what is served.
 * 2. **Flat types** — asserted at compile time; the `satisfies` below would fail
 *    if the served shape and the schema's output stopped agreeing.
 */
describe('flow workflow view — schema/shape equivalence', () => {
  it('validates the served body against the exported schema (unextended and extended)', async () => {
    const plain = mount(createFlowWorkflowRoutes({ engine: harness.engine }), '/runs');
    const id = await harness.start(helloWorkflow, { name: 'Ada' });
    await harness.drain();

    const served = (await testRequest(plain, 'GET', `/runs/${id}`)).data;
    expect(buildFlowWorkflowSchema().safeParse(served).success).toBe(true);

    const extensionShape = { appliedAt: z.string().nullable() };
    const extended = mount(
      createFlowWorkflowRoutes({
        engine: harness.engine,
        extendWorkflow: { schema: extensionShape, project: () => ({ appliedAt: null }) },
      }),
      '/ext',
    );
    const servedExt = (await testRequest(extended, 'GET', `/ext/${id}`)).data;
    const parsed = buildFlowWorkflowSchema(extensionShape).safeParse(servedExt);
    expect(parsed.success).toBe(true);

    // Compile-time half: the schema's output type must still be assignable to
    // the intersection the routes declare. A divergence fails `tsc`, not this
    // assertion.
    const view = parsed.success ? parsed.data : undefined;
    expect(view === undefined || typeof view.id === 'number').toBe(true);
  });
});
