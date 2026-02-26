import { describe, it, expect, beforeAll, afterAll, beforeEach, inject } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createWorkflowEngine } from './engine.ts';
import { createStepHandlerRegistry } from './step-handler-registry.ts';
import type { StepHandler } from './types.ts';
import { workflowStepTable, workflowTable } from './tables.ts';

export const testSchema = {
  workflow: workflowTable,
  workflowStep: workflowStepTable,
};

let pool: Pool;
let db: NodePgDatabase<typeof testSchema>;

const TENANT_ID = 'test-tenant';

function noopLogger() {
  return {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  } as any;
}

beforeAll(async () => {
  const connectionString = inject('testDbConnectionString');
  pool = new Pool({ connectionString });
  db = drizzle({ client: pool, schema: testSchema });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.execute(sql.raw('TRUNCATE TABLE workflow_step, workflow RESTART IDENTITY CASCADE'));
});

describe('workflow engine integration', () => {
  it('starts a single-step workflow and creates records', async () => {
    const registry = createStepHandlerRegistry();
    const handler: StepHandler = async () => ({ ok: true, value: { result: 'done' } });
    registry.register('simple-handler', handler);

    const enqueuedJobs: any[] = [];
    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async (payload) => {
        enqueuedJobs.push(payload);
        return { ok: true, value: { jobId: `job-${payload.stepId}`, queue: 'test' } };
      },
      tenantId: TENANT_ID,
    });

    const result = await engine.startWorkflow(
      {
        type: 'simple',
        steps: [{ key: 'step-1', type: 'simple-handler' }],
      },
      { input: 'data' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalSteps).toBe(1);
    expect(result.value.enqueuedSteps).toEqual(['step-1']);
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0].stepKey).toBe('step-1');

    // Verify DB state
    const status = await engine.getWorkflowStatus(result.value.workflowId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.value.type).toBe('simple');
    expect(status.value.status).toBe('running');
    expect(status.value.totalSteps).toBe(1);
    expect(status.value.steps).toHaveLength(1);
    expect(status.value.steps[0]!.key).toBe('step-1');
    expect(status.value.steps[0]!.status).toBe('pending');
  });

  it('executes a step and marks workflow complete', async () => {
    const registry = createStepHandlerRegistry();
    const handler: StepHandler = async () => ({ ok: true, value: { answer: 42 } });
    registry.register('compute', handler);

    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async (payload) => ({ ok: true, value: { jobId: `job-${payload.stepId}`, queue: 'test' } }),
      tenantId: TENANT_ID,
    });

    const startResult = await engine.startWorkflow(
      { type: 'compute-wf', steps: [{ key: 'compute', type: 'compute' }] },
      {},
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const { workflowId } = startResult.value;

    // Get the step ID from the DB
    const status = await engine.getWorkflowStatus(workflowId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const stepId = status.value.steps[0]!.id;

    // Execute the step
    const execResult = await engine.executeStep(workflowId, stepId);
    expect(execResult.ok).toBe(true);

    // Workflow should be completed now
    const finalStatus = await engine.getWorkflowStatus(workflowId);
    expect(finalStatus.ok).toBe(true);
    if (!finalStatus.ok) return;

    expect(finalStatus.value.status).toBe('completed');
    expect(finalStatus.value.completedSteps).toBe(1);
    expect(finalStatus.value.steps[0]!.status).toBe('completed');
    expect(finalStatus.value.steps[0]!.output).toEqual({ answer: 42 });
  });

  it('runs a multi-step DAG workflow end-to-end', async () => {
    const registry = createStepHandlerRegistry();

    const fetchHandler: StepHandler = async () => ({ ok: true, value: { data: 'raw-data' } });
    const processHandler: StepHandler = async (ctx) => {
      const fetchOutput = ctx.dependencyOutputs['fetch'] as any;
      return { ok: true, value: { processed: `${fetchOutput.data}-processed` } };
    };

    registry.register('fetch', fetchHandler);
    registry.register('process', processHandler);

    const enqueuedJobs: any[] = [];
    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async (payload) => {
        enqueuedJobs.push(payload);
        return { ok: true, value: { jobId: `job-${payload.stepId}`, queue: 'test' } };
      },
      tenantId: TENANT_ID,
    });

    const definition = {
      type: 'pipeline',
      steps: [
        { key: 'fetch', type: 'fetch' },
        { key: 'process', type: 'process', dependencies: ['fetch'] },
      ],
    };

    const startResult = await engine.startWorkflow(definition, { url: 'https://example.com' });
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { workflowId } = startResult.value;

    // Only 'fetch' should be enqueued (no dependencies)
    expect(startResult.value.enqueuedSteps).toEqual(['fetch']);
    expect(enqueuedJobs).toHaveLength(1);

    // Execute fetch step
    const fetchStepId = enqueuedJobs[0].stepId;
    await engine.executeStep(workflowId, fetchStepId);

    // 'process' should now be enqueued
    expect(enqueuedJobs).toHaveLength(2);
    expect(enqueuedJobs[1].stepKey).toBe('process');

    // Execute process step
    const processStepId = enqueuedJobs[1].stepId;
    await engine.executeStep(workflowId, processStepId);

    // Workflow should be completed with aggregated output
    const finalStatus = await engine.getWorkflowStatus(workflowId);
    expect(finalStatus.ok).toBe(true);
    if (!finalStatus.ok) return;

    expect(finalStatus.value.status).toBe('completed');
    expect(finalStatus.value.completedSteps).toBe(2);
    expect(finalStatus.value.output).toEqual({
      fetch: { data: 'raw-data' },
      process: { processed: 'raw-data-processed' },
    });
  });

  it('handles step failure and skips downstream steps', async () => {
    const registry = createStepHandlerRegistry();

    const failHandler: StepHandler = async () => ({
      ok: false,
      error: { key: 'step_error', message: 'Fetch failed', retryable: false },
    });
    const neverHandler: StepHandler = async () => ({ ok: true, value: {} });

    registry.register('fail-step', failHandler);
    registry.register('downstream', neverHandler);

    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async (payload) => ({ ok: true, value: { jobId: `job-${payload.stepId}`, queue: 'test' } }),
      tenantId: TENANT_ID,
    });

    const startResult = await engine.startWorkflow(
      {
        type: 'fail-test',
        steps: [
          { key: 'fetch', type: 'fail-step' },
          { key: 'process', type: 'downstream', dependencies: ['fetch'] },
        ],
      },
      {},
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { workflowId } = startResult.value;

    // Get fetch step id
    const initialStatus = await engine.getWorkflowStatus(workflowId);
    expect(initialStatus.ok).toBe(true);
    if (!initialStatus.ok) return;
    const fetchStepId = initialStatus.value.steps.find((s) => s.key === 'fetch')!.id;

    // Execute fetch (will fail)
    await engine.executeStep(workflowId, fetchStepId);

    // Workflow should be failed, process should be skipped
    const finalStatus = await engine.getWorkflowStatus(workflowId);
    expect(finalStatus.ok).toBe(true);
    if (!finalStatus.ok) return;

    expect(finalStatus.value.status).toBe('failed');
    expect(finalStatus.value.failedSteps).toBe(1);

    const fetchStep = finalStatus.value.steps.find((s) => s.key === 'fetch');
    const processStep = finalStatus.value.steps.find((s) => s.key === 'process');

    expect(fetchStep?.status).toBe('failed');
    expect(fetchStep?.error).toBe('Fetch failed');
    expect(processStep?.status).toBe('skipped');
  });

  it('cancels a running workflow', async () => {
    const registry = createStepHandlerRegistry();
    registry.register('handler', async () => ({ ok: true, value: {} }));

    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async (payload) => ({ ok: true, value: { jobId: `job-${payload.stepId}`, queue: 'test' } }),
      tenantId: TENANT_ID,
    });

    const startResult = await engine.startWorkflow(
      {
        type: 'cancel-test',
        steps: [
          { key: 'step-1', type: 'handler' },
          { key: 'step-2', type: 'handler', dependencies: ['step-1'] },
        ],
      },
      {},
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { workflowId } = startResult.value;

    const cancelResult = await engine.cancelWorkflow(workflowId);
    expect(cancelResult.ok).toBe(true);

    const status = await engine.getWorkflowStatus(workflowId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.value.status).toBe('cancelled');
    // Pending steps should be skipped
    const pendingSteps = status.value.steps.filter((s) => s.status === 'pending');
    expect(pendingSteps).toHaveLength(0);
  });

  it('lists workflows with filtering', async () => {
    const registry = createStepHandlerRegistry();
    registry.register('handler', async () => ({ ok: true, value: {} }));

    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async (payload) => ({ ok: true, value: { jobId: `job-${payload.stepId}`, queue: 'test' } }),
      tenantId: TENANT_ID,
    });

    // Create two workflows of different types
    await engine.startWorkflow(
      { type: 'type-a', steps: [{ key: 's1', type: 'handler' }] },
      {},
    );
    await engine.startWorkflow(
      { type: 'type-b', steps: [{ key: 's1', type: 'handler' }] },
      {},
    );

    // List all
    const allResult = await engine.listWorkflows();
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;
    expect(allResult.value).toHaveLength(2);

    // Filter by type
    const filteredResult = await engine.listWorkflows({ type: 'type-a' });
    expect(filteredResult.ok).toBe(true);
    if (!filteredResult.ok) return;
    expect(filteredResult.value).toHaveLength(1);
    expect(filteredResult.value[0]!.type).toBe('type-a');
  });

  it('returns workflow_not_found for non-existent workflow', async () => {
    const registry = createStepHandlerRegistry();
    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async () => ({ ok: true, value: { jobId: '1', queue: 'test' } }),
      tenantId: TENANT_ID,
    });

    const result = await engine.getWorkflowStatus(99999);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('workflow_not_found');
    }
  });

  it('handles handleStepExhausted for DLQ scenarios', async () => {
    const registry = createStepHandlerRegistry();
    registry.register('handler', async () => ({ ok: true, value: {} }));

    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async (payload) => ({ ok: true, value: { jobId: `job-${payload.stepId}`, queue: 'test' } }),
      tenantId: TENANT_ID,
    });

    const startResult = await engine.startWorkflow(
      { type: 'dlq-test', steps: [{ key: 'step-1', type: 'handler' }] },
      {},
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { workflowId } = startResult.value;

    const status = await engine.getWorkflowStatus(workflowId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const stepId = status.value.steps[0]!.id;

    // Simulate DLQ exhaustion
    await engine.handleStepExhausted(workflowId, stepId, 'Exhausted all retries');

    const finalStatus = await engine.getWorkflowStatus(workflowId);
    expect(finalStatus.ok).toBe(true);
    if (!finalStatus.ok) return;

    expect(finalStatus.value.status).toBe('failed');
    expect(finalStatus.value.steps[0]!.status).toBe('failed');
    expect(finalStatus.value.steps[0]!.error).toBe('Exhausted all retries');
  });

  it('skips execution for cancelled workflow', async () => {
    const registry = createStepHandlerRegistry();
    let handlerCalled = false;
    registry.register('handler', async () => {
      handlerCalled = true;
      return { ok: true, value: {} };
    });

    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async (payload) => ({ ok: true, value: { jobId: `job-${payload.stepId}`, queue: 'test' } }),
      tenantId: TENANT_ID,
    });

    const startResult = await engine.startWorkflow(
      { type: 'skip-test', steps: [{ key: 'step-1', type: 'handler' }] },
      {},
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { workflowId } = startResult.value;

    // Cancel first
    await engine.cancelWorkflow(workflowId);

    // Then try to execute step
    const status = await engine.getWorkflowStatus(workflowId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const stepId = status.value.steps[0]!.id;

    const execResult = await engine.executeStep(workflowId, stepId);
    expect(execResult.ok).toBe(true); // Silently skipped
    expect(handlerCalled).toBe(false);
  });

  it('handles parallel branches in a diamond DAG', async () => {
    const registry = createStepHandlerRegistry();

    registry.register('start', async () => ({ ok: true, value: { started: true } }));
    registry.register('branch-a', async () => ({ ok: true, value: { a: 'done' } }));
    registry.register('branch-b', async () => ({ ok: true, value: { b: 'done' } }));
    registry.register('merge', async (ctx) => ({
      ok: true,
      value: {
        merged: true,
        fromA: (ctx.dependencyOutputs['branch-a'] as any)?.a,
        fromB: (ctx.dependencyOutputs['branch-b'] as any)?.b,
      },
    }));

    const enqueuedJobs: any[] = [];
    const engine = createWorkflowEngine({
      db,
      tables: { workflow: workflowTable, workflowStep: workflowStepTable },
      logger: noopLogger(),
      stepHandlerRegistry: registry,
      enqueueStepJob: async (payload) => {
        enqueuedJobs.push(payload);
        return { ok: true, value: { jobId: `job-${payload.stepId}`, queue: 'test' } };
      },
      tenantId: TENANT_ID,
    });

    const startResult = await engine.startWorkflow(
      {
        type: 'diamond',
        steps: [
          { key: 'start', type: 'start' },
          { key: 'branch-a', type: 'branch-a', dependencies: ['start'] },
          { key: 'branch-b', type: 'branch-b', dependencies: ['start'] },
          { key: 'merge', type: 'merge', dependencies: ['branch-a', 'branch-b'] },
        ],
      },
      {},
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { workflowId } = startResult.value;

    // Only 'start' enqueued initially
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0].stepKey).toBe('start');

    // Execute 'start'
    await engine.executeStep(workflowId, enqueuedJobs[0].stepId);

    // Now branch-a and branch-b should be enqueued (parallel)
    expect(enqueuedJobs).toHaveLength(3);
    const branchKeys = enqueuedJobs.slice(1).map((j: any) => j.stepKey).sort();
    expect(branchKeys).toEqual(['branch-a', 'branch-b']);

    // Execute both branches
    const branchAJob = enqueuedJobs.find((j: any) => j.stepKey === 'branch-a');
    const branchBJob = enqueuedJobs.find((j: any) => j.stepKey === 'branch-b');

    await engine.executeStep(workflowId, branchAJob.stepId);

    // After branch-a completes, merge should NOT be enqueued yet (branch-b still pending)
    const afterA = enqueuedJobs.filter((j: any) => j.stepKey === 'merge');
    expect(afterA).toHaveLength(0);

    await engine.executeStep(workflowId, branchBJob.stepId);

    // Now merge should be enqueued
    const mergeJob = enqueuedJobs.find((j: any) => j.stepKey === 'merge');
    expect(mergeJob).toBeDefined();

    await engine.executeStep(workflowId, mergeJob.stepId);

    // Workflow should be completed
    const finalStatus = await engine.getWorkflowStatus(workflowId);
    expect(finalStatus.ok).toBe(true);
    if (!finalStatus.ok) return;

    expect(finalStatus.value.status).toBe('completed');
    expect(finalStatus.value.completedSteps).toBe(4);
    expect((finalStatus.value.output as any).merge).toEqual({
      merged: true,
      fromA: 'done',
      fromB: 'done',
    });
  });
});
