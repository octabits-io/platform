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
import { createFlowWorkflowRoutes } from './flow.ts';
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
