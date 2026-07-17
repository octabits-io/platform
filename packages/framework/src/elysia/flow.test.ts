/**
 * `createFlowWorkflowRoutes` over a real in-memory flow engine — the routes,
 * flow's public-view projection, and the extension seam, all through
 * `app.handle` with no database or queue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Elysia } from 'elysia';
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
} from '@octabits-io/flow';
import type { WorkflowWithSteps } from '@octabits-io/flow';
import { createFlowWorkflowRoutes, type FlowEngineReader } from './flow.ts';
import { testRequest } from './testing.ts';

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
        await engine.executeStep(job.workflowId, job.stepId);
      }
    },
    async start(workflow, input, options) {
      const started = await workflow.start(engine, input, options);
      if (!started.ok) throw new Error(started.error.message);
      return started.value.workflowId;
    },
  };
}

let harness: Harness;
let app: Elysia<any, any, any, any, any, any>;

beforeEach(() => {
  harness = createHarness();
  app = new Elysia().use(
    createFlowWorkflowRoutes({
      engine: harness.engine,
      errorOverrides: { quota_exceeded: 429 },
    }),
  );
});

describe('createFlowWorkflowRoutes', () => {
  it('serves the public view of a completed workflow — internals stay off the wire', async () => {
    const id = await harness.start(helloWorkflow, { name: 'Ada' }, { entityRef: 'thing:1' });
    await harness.drain();

    const res = await testRequest(app, 'GET', `/workflows/${id}`);
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

    const active = await testRequest(app, 'GET', '/workflows/active?entityRef=thing:2');
    expect((active.data as { active: boolean }).active).toBe(true);

    const listed = await testRequest(app, 'GET', '/workflows?entityRef=thing:2&limit=2');
    const items = (listed.data as { items: { id: number }[] }).items;
    expect(items.map((w) => w.id)).toEqual([second, first]);

    await harness.drain();
    const after = await testRequest(app, 'GET', '/workflows/active?entityRef=thing:2');
    expect((after.data as { active: boolean }).active).toBe(false);
  });

  it('serves the status snapshot projection', async () => {
    const id = await harness.start(helloWorkflow, { name: 'Ada' });
    await harness.drain();
    const res = await testRequest(app, 'GET', `/workflows/${id}/status`);
    expect(res.data).toEqual({ status: 'completed', totalSteps: 2, completedSteps: 2 });
  });

  it('cancels with a 200 body (the node 204 quirk)', async () => {
    const id = await harness.start(helloWorkflow, { name: 'Ada' });
    const res = await testRequest(app, 'POST', `/workflows/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ cancelled: true });
    await harness.drain();
    const status = await testRequest(app, 'GET', `/workflows/${id}/status`);
    expect((status.data as { status: string }).status).toBe('cancelled');
  });

  it('resumes a waiting step and folds `waiting` to `running` on the wire', async () => {
    const id = await harness.start(gateWorkflow, {});
    await harness.drain();

    // The wait step suspended: engine status `waiting`, wire status `running`.
    const waiting = await testRequest(app, 'GET', `/workflows/${id}`);
    const step = (waiting.data as { steps: { status: string }[] }).steps[0];
    expect(step?.status).toBe('running');

    const resumed = await testRequest(app, 'POST', `/workflows/${id}/resume`, {
      body: { stepKey: 'gate', payload: { approved: true } },
    });
    expect(resumed.status).toBe(200);
    await harness.drain();

    const done = await testRequest(app, 'GET', `/workflows/${id}`);
    expect((done.data as { status: string; output: { gate: { approved: boolean } } }).output.gate.approved).toBe(true);
  });

  it('maps workflow_not_found to 404 by key convention', async () => {
    const res = await testRequest(app, 'GET', '/workflows/999999');
    expect(res.status).toBe(404);
    expect((res.data as { key: string }).key).toBe('workflow_not_found');
  });

  it('resolves the engine per request when given a resolver', async () => {
    const seen: unknown[] = [];
    const perRequest = new Elysia().use(
      createFlowWorkflowRoutes({
        engine: (ctx) => {
          seen.push(ctx);
          return harness.engine;
        },
      }),
    );
    const id = await harness.start(helloWorkflow, { name: 'Ada' });
    await harness.drain();
    const res = await testRequest(perRequest, 'GET', `/workflows/${id}/status`);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    // The resolver gets the live handler context (headers prove it).
    expect((seen[0] as { request: Request }).request).toBeInstanceOf(Request);
  });

  it('gates each route through authorize, mapping the returned key', async () => {
    const guarded = new Elysia().use(
      createFlowWorkflowRoutes({
        engine: harness.engine,
        authorize: (action) =>
          action === 'cancel' ? { key: 'forbidden', message: 'jobs:cancel required' } : undefined,
      }),
    );
    const id = await harness.start(helloWorkflow, { name: 'Ada' });

    const denied = await testRequest(guarded, 'POST', `/workflows/${id}/cancel`);
    expect(denied.status).toBe(403);
    expect((denied.data as { key: string }).key).toBe('forbidden');

    const allowed = await testRequest(guarded, 'GET', `/workflows/${id}/status`);
    expect(allowed.status).toBe(200);
  });

  it('excludes child steps by default; includeChildSteps opts back in', async () => {
    const workflow: WorkflowWithSteps = {
      id: 1, type: 'mapper', status: 'running', partitionKey: 'test',
      input: {}, output: null, error: null, entityRef: null, idempotencyKey: null,
      parentWorkflowId: null, parentStepId: null, totalSteps: 1, completedSteps: 0,
      failedSteps: 0, metadata: null, createdAt: 'c', startedAt: null, completedAt: null,
      steps: [
        {
          id: 10, workflowId: 1, key: 'fanout', type: 'map', status: 'mapping',
          dependencies: [], input: null, output: null, error: null, metadata: null,
          attempts: 1, parentStepId: null, startedAt: null, completedAt: null,
        },
        {
          id: 11, workflowId: 1, key: 'fanout#0', type: 'map-item', status: 'running',
          dependencies: [], input: null, output: null, error: null, metadata: null,
          attempts: 1, parentStepId: 10, startedAt: null, completedAt: null,
        },
      ],
    };
    const stub: FlowEngineReader = {
      getWorkflowStatus: async () => ({ ok: true, value: workflow }),
      listWorkflows: async () => ({ ok: true, value: [workflow] }),
      cancelWorkflow: async () => ({ ok: true, value: undefined }),
      resumeStep: async () => ({ ok: true, value: undefined }),
    };

    const dflt = new Elysia().use(createFlowWorkflowRoutes({ engine: stub }));
    const res = await testRequest(dflt, 'GET', '/workflows/1');
    const steps = (res.data as { steps: { key: string; status: string }[] }).steps;
    expect(steps.map((s) => s.key)).toEqual(['fanout']);
    expect(steps[0]?.status).toBe('running'); // mapping folded

    const withChildren = new Elysia().use(
      createFlowWorkflowRoutes({ engine: stub, includeChildSteps: true }),
    );
    const res2 = await testRequest(withChildren, 'GET', '/workflows/1');
    expect((res2.data as { steps: { key: string }[] }).steps.map((s) => s.key)).toEqual([
      'fanout',
      'fanout#0',
    ]);
  });

  it('keeps parent path params visible on the /:id routes (loose params schema)', async () => {
    // Regression: consumers mount these routes under prefixes with their own
    // path params (e.g. /tenant/:tenantId) and read them in a request-scope
    // plugin / the engine resolver. A strict params schema would strip them
    // during validation, breaking every /:id route for such consumers.
    const workflow: WorkflowWithSteps = {
      id: 7, type: 'demo', status: 'completed', partitionKey: 'test',
      input: {}, output: null, error: null, entityRef: null, idempotencyKey: null,
      parentWorkflowId: null, parentStepId: null, totalSteps: 1, completedSteps: 1,
      failedSteps: 0, metadata: null, createdAt: 'c', startedAt: null, completedAt: null,
      steps: [],
    };
    const stub: FlowEngineReader = {
      getWorkflowStatus: async () => ({ ok: true, value: workflow }),
      listWorkflows: async () => ({ ok: true, value: [workflow] }),
      cancelWorkflow: async () => ({ ok: true, value: undefined }),
      resumeStep: async () => ({ ok: true, value: undefined }),
    };
    const seenTenantIds: (string | undefined)[] = [];
    const app2 = new Elysia().group('/tenant/:tenantId', (g) =>
      g.use(
        createFlowWorkflowRoutes({
          engine: (ctx) => {
            seenTenantIds.push((ctx as { params?: { tenantId?: string } }).params?.tenantId);
            return stub;
          },
        }),
      ),
    );

    const status = await testRequest(app2, 'GET', '/tenant/acme/workflows/7/status');
    expect(status.status).toBe(200);
    const get = await testRequest(app2, 'GET', '/tenant/acme/workflows/7');
    expect(get.status).toBe(200);
    expect(seenTenantIds).toEqual(['acme', 'acme']);
  });

  it('batches extendWorkflow.load once per request and hands it to project', async () => {
    const loadCalls: number[][] = [];
    const app2 = new Elysia().use(
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

    const listed = await testRequest(app2, 'GET', '/workflows?entityRef=batch:1');
    const items = (listed.data as { items: { id: number; label: string }[] }).items;
    expect(items.map((w) => w.label).sort()).toEqual([`wf-${a}`, `wf-${b}`].sort());
    expect(loadCalls).toHaveLength(1); // one batch for the whole list
    expect(loadCalls[0]?.slice().sort()).toEqual([a, b].sort());
  });

  it('extends the wire shape via extendWorkflow — schema and value in lockstep', async () => {
    const extended = new Elysia().use(
      createFlowWorkflowRoutes({
        engine: harness.engine,
        prefix: '/runs',
        extendWorkflow: {
          schema: { appliedAt: z.string().nullable() },
          project: (wf) => ({ appliedAt: (wf.metadata?.appliedAt as string | undefined) ?? null }),
        },
      }),
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
