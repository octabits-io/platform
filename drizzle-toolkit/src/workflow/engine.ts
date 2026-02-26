import { eq, and, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { Result } from '@octabits-io/foundation/result';
import type { Logger } from '@octabits-io/foundation/logger';
import type { ServiceResolver } from '@octabits-io/foundation/ioc';
import type { QueuedJob, QueueError } from './queue';
import type {
  WorkflowDefinition,
  StepHandlerRegistry,
  WorkflowCreatedResult,
  WorkflowStatusResult,
  WorkflowStepStatusResult,
  WorkflowError,
  StepExecutionContext,
  WorkflowStatus,
  WorkflowStepStatus,
} from './types.ts';
import type { WorkflowStepJobPayload } from './schema.ts';
import type { workflowTable, workflowStepTable } from './tables.ts';

// ============================================================================
// Dependencies
// ============================================================================

export interface WorkflowEngineDeps<TServices = Record<string, unknown>> {
  db: PgDatabase<any, any, any>;
  /** Database tables for workflow and workflow step records */
  tables: {
    workflow: typeof workflowTable;
    workflowStep: typeof workflowStepTable;
  };
  logger: Logger;
  stepHandlerRegistry: StepHandlerRegistry;
  /** Function to enqueue a step job (tenantId injected by the queue) */
  enqueueStepJob: (payload: Omit<WorkflowStepJobPayload, 'tenantId'>) => Promise<Result<QueuedJob, QueueError>>;
  /** Tenant ID — injected at construction time via IoC scope */
  tenantId: string;
  /** IoC container from the request scope. Optional for testing. */
  container?: ServiceResolver<TServices>;
  /**
   * Optional: build step execution context from the base context.
   * Use this to inject additional fields (e.g., AI model) into the context.
   */
  buildStepContext?: (ctx: StepExecutionContext<TServices>) => Promise<StepExecutionContext<TServices>>;
}

// ============================================================================
// Factory
// ============================================================================

export function createWorkflowEngine<TServices = Record<string, unknown>>(
  deps: WorkflowEngineDeps<TServices>
) {
  const { db, tables, logger, stepHandlerRegistry, enqueueStepJob, tenantId } = deps;

  /**
   * Validates a workflow definition for correctness:
   * - All step keys are unique
   * - All dependency references are valid
   * - No circular dependencies
   * - All step types have registered handlers
   */
  function validateDefinition(definition: WorkflowDefinition): Result<void, WorkflowError> {
    const { steps } = definition;

    if (steps.length === 0) {
      return {
        ok: false,
        error: { key: 'invalid_workflow_definition_error', message: 'Workflow must have at least one step' },
      };
    }

    // Check unique keys
    const keys = new Set<string>();
    for (const step of steps) {
      if (keys.has(step.key)) {
        return {
          ok: false,
          error: { key: 'invalid_workflow_definition_error', message: `Duplicate step key: ${step.key}` },
        };
      }
      keys.add(step.key);
    }

    // Check dependency references
    for (const step of steps) {
      for (const dep of step.dependencies ?? []) {
        if (!keys.has(dep)) {
          return {
            ok: false,
            error: {
              key: 'invalid_workflow_definition_error',
              message: `Step '${step.key}' depends on unknown step '${dep}'`,
            },
          };
        }
        if (dep === step.key) {
          return {
            ok: false,
            error: { key: 'invalid_workflow_definition_error', message: `Step '${step.key}' cannot depend on itself` },
          };
        }
      }
    }

    // Detect cycles via topological sort (Kahn's algorithm)
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const step of steps) {
      inDegree.set(step.key, (step.dependencies ?? []).length);
      adjacency.set(step.key, []);
    }
    for (const step of steps) {
      for (const dep of step.dependencies ?? []) {
        adjacency.get(dep)!.push(step.key);
      }
    }

    const queue: string[] = [];
    for (const [key, deg] of inDegree) {
      if (deg === 0) queue.push(key);
    }

    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      visited++;
      for (const neighbor of adjacency.get(current) ?? []) {
        const newDeg = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (visited !== steps.length) {
      return {
        ok: false,
        error: { key: 'invalid_workflow_definition_error', message: 'Workflow contains circular dependencies' },
      };
    }

    // Check all handlers exist
    for (const step of steps) {
      if (!stepHandlerRegistry.has(step.type)) {
        return {
          ok: false,
          error: {
            key: 'step_handler_not_found',
            message: `No handler registered for step type '${step.type}'`,
            stepType: step.type,
          },
        };
      }
    }

    return { ok: true, value: undefined };
  }

  /**
   * Start a new workflow.
   * Creates the workflow + step records in the DB and enqueues steps with no dependencies.
   *
   * @param definition - Workflow definition (steps, type, etc.)
   * @param input - Workflow input data
   * @param options - Optional configuration
   * @param options.entityRef - Entity reference for efficient filtering (e.g., "listing:123")
   */
  async function startWorkflow(
    definition: WorkflowDefinition,
    input: Record<string, unknown>,
    options?: { entityRef?: string }
  ): Promise<Result<WorkflowCreatedResult, WorkflowError>> {
    const validation = validateDefinition(definition);
    if (!validation.ok) return validation;

    const { steps } = definition;

    // Create workflow + steps in a transaction
    const workflowId = await db.transaction(async (tx) => {
      const [workflow] = await tx
        .insert(tables.workflow)
        .values({
          tenantId,
          type: definition.type,
          status: 'running',
          input,
          totalSteps: steps.length,
          entityRef: options?.entityRef,
          startedAt: new Date().toISOString(),
        })
        .returning({ id: tables.workflow.id });

      const id = workflow!.id;

      await tx.insert(tables.workflowStep).values(
        steps.map((step) => ({
          workflowId: id,
          tenantId,
          key: step.key,
          type: step.type,
          status: 'pending' as WorkflowStepStatus,
          dependencies: step.dependencies ?? [],
          input: step.input ?? null,
        }))
      );

      return id;
    });

    // Load step IDs for enqueuing
    const dbSteps = await db
      .select()
      .from(tables.workflowStep)
      .where(
        and(
          eq(tables.workflowStep.workflowId, workflowId),
          eq(tables.workflowStep.tenantId, tenantId),
        )
      );

    // Enqueue steps with no dependencies (can start immediately / in parallel)
    const readySteps = steps.filter((s) => !s.dependencies || s.dependencies.length === 0);
    const enqueuedStepKeys: string[] = [];

    for (const readyStep of readySteps) {
      const dbStep = dbSteps.find((s) => s.key === readyStep.key);
      if (!dbStep) continue;

      const result = await enqueueStepJob({
        workflowId,
        stepId: dbStep.id,
        stepKey: readyStep.key,
        stepType: readyStep.type,
      });

      if (result.ok) {
        enqueuedStepKeys.push(readyStep.key);
      } else {
        logger.error('Failed to enqueue workflow step', new Error(result.error.message));
      }
    }

    logger.info('Workflow started', {
      workflowId,
      type: definition.type,
      totalSteps: steps.length,
      enqueuedSteps: enqueuedStepKeys,
    });

    return {
      ok: true,
      value: { workflowId, totalSteps: steps.length, enqueuedSteps: enqueuedStepKeys },
    };
  }

  /**
   * Execute a step. Called by the queue worker.
   * Resolves dependency outputs, runs the handler, and advances the workflow.
   */
  async function executeStep(
    workflowId: number,
    stepId: number
  ): Promise<Result<void, WorkflowError>> {
    const workflow = await db
      .select()
      .from(tables.workflow)
      .where(
        and(
          eq(tables.workflow.id, workflowId),
          eq(tables.workflow.tenantId, tenantId),
        )
      )
      .then((rows) => rows[0]);

    if (!workflow) {
      return { ok: false, error: { key: 'workflow_not_found', message: `Workflow ${workflowId} not found` } };
    }

    // Skip if workflow is already in a terminal state
    if (workflow.status === 'cancelled' || workflow.status === 'failed') {
      logger.info('Skipping step for non-active workflow', { workflowId, stepId, status: workflow.status });
      return { ok: true, value: undefined };
    }

    const step = await db
      .select()
      .from(tables.workflowStep)
      .where(
        and(
          eq(tables.workflowStep.id, stepId),
          eq(tables.workflowStep.workflowId, workflowId),
        )
      )
      .then((rows) => rows[0]);

    if (!step) {
      return { ok: false, error: { key: 'workflow_not_found', message: `Step ${stepId} not found` } };
    }

    // Mark step as running
    await db
      .update(tables.workflowStep)
      .set({ status: 'running', startedAt: new Date().toISOString() })
      .where(eq(tables.workflowStep.id, stepId));

    // Load dependency outputs
    const dependencyOutputs: Record<string, unknown> = {};
    const stepDeps = (step.dependencies as string[]) ?? [];
    if (stepDeps.length > 0) {
      const depSteps = await db
        .select()
        .from(tables.workflowStep)
        .where(eq(tables.workflowStep.workflowId, workflowId));

      for (const depKey of stepDeps) {
        const depStep = depSteps.find((s) => s.key === depKey);
        if (!depStep || depStep.status !== 'completed') {
          logger.error('Step dependency not completed', new Error(`Dependency '${depKey}' is ${depStep?.status ?? 'missing'}`));
          return {
            ok: false,
            error: { key: 'step_error', message: `Dependency '${depKey}' is not completed` },
          };
        }
        dependencyOutputs[depKey] = depStep.output;
      }
    }

    // Resolve handler
    const handler = stepHandlerRegistry.get(step.type);
    if (!handler) {
      await markStepFailed(stepId, workflowId, `No handler for step type '${step.type}'`);
      return {
        ok: false,
        error: { key: 'step_handler_not_found', message: `No handler for '${step.type}'`, stepType: step.type },
      };
    }

    // Execute handler
    try {
      let ctx: StepExecutionContext<TServices> = {
        workflowId,
        stepId,
        stepKey: step.key,
        tenantId,
        workflowInput: (workflow.input as Record<string, unknown>) ?? {},
        stepInput: (step.input as Record<string, unknown>) ?? {},
        dependencyOutputs,
        container: deps.container,
      };

      // Allow consumers to enrich the context (e.g., inject AI model)
      if (deps.buildStepContext) {
        ctx = await deps.buildStepContext(ctx);
      }

      const handlerResult = await handler(ctx as StepExecutionContext);

      if (handlerResult.ok) {
        await onStepCompleted(workflowId, stepId, handlerResult.value);
      } else {
        await markStepFailed(stepId, workflowId, handlerResult.error.message);
        await checkWorkflowFailure(workflowId);
      }

      return { ok: true, value: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown step execution error';
      logger.error('Step execution threw', error instanceof Error ? error : new Error(message));
      await markStepFailed(stepId, workflowId, message);
      await checkWorkflowFailure(workflowId);
      // Re-throw so the queue can retry
      throw error;
    }
  }

  /**
   * Called when a step completes successfully.
   * Saves output, increments counter, and enqueues newly-ready steps.
   */
  async function onStepCompleted(
    workflowId: number,
    stepId: number,
    output: Record<string, unknown>
  ): Promise<void> {
    const now = new Date().toISOString();

    // Mark step completed and atomically increment workflow counter
    await db
      .update(tables.workflowStep)
      .set({ status: 'completed', output, completedAt: now })
      .where(eq(tables.workflowStep.id, stepId));

    await db
      .update(tables.workflow)
      .set({
        completedSteps: sql`${tables.workflow.completedSteps} + 1`,
        updatedAt: now,
      })
      .where(eq(tables.workflow.id, workflowId));

    // Load all steps to determine what's next
    const allSteps = await db
      .select()
      .from(tables.workflowStep)
      .where(eq(tables.workflowStep.workflowId, workflowId));

    const completedKeys = new Set(
      allSteps.filter((s) => s.status === 'completed').map((s) => s.key)
    );

    // Find pending steps whose dependencies are all now completed
    const newlyReady = allSteps.filter((s) => {
      if (s.status !== 'pending') return false;
      const sDeps = (s.dependencies as string[]) ?? [];
      return sDeps.every((dep) => completedKeys.has(dep));
    });

    // Enqueue them (they will run in parallel via the queue)
    for (const readyStep of newlyReady) {
      const result = await enqueueStepJob({
        workflowId,
        stepId: readyStep.id,
        stepKey: readyStep.key,
        stepType: readyStep.type,
      });

      if (!result.ok) {
        logger.error('Failed to enqueue next step', new Error(result.error.message));
      } else {
        logger.info('Enqueued next step', { workflowId, stepKey: readyStep.key });
      }
    }

    // Check if workflow is fully complete
    const allTerminal = allSteps.every(
      (s) => s.id === stepId || s.status === 'completed' || s.status === 'skipped'
    );

    if (allTerminal && newlyReady.length === 0) {
      const aggregatedOutput: Record<string, unknown> = {};
      for (const s of allSteps) {
        if (s.status === 'completed' || s.id === stepId) {
          aggregatedOutput[s.key] = s.id === stepId ? output : s.output;
        }
      }

      await db
        .update(tables.workflow)
        .set({ status: 'completed', output: aggregatedOutput, completedAt: now, updatedAt: now })
        .where(eq(tables.workflow.id, workflowId));

      logger.info('Workflow completed', { workflowId });
    }
  }

  async function markStepFailed(stepId: number, workflowId: number, errorMessage: string): Promise<void> {
    const now = new Date().toISOString();

    await db
      .update(tables.workflowStep)
      .set({ status: 'failed', error: errorMessage, completedAt: now })
      .where(eq(tables.workflowStep.id, stepId));

    await db
      .update(tables.workflow)
      .set({ failedSteps: sql`${tables.workflow.failedSteps} + 1`, updatedAt: now })
      .where(eq(tables.workflow.id, workflowId));
  }

  /**
   * After a step failure, check if blocked downstream steps should be skipped
   * and whether the workflow should be marked as failed.
   */
  async function checkWorkflowFailure(workflowId: number): Promise<void> {
    const allSteps = await db
      .select()
      .from(tables.workflowStep)
      .where(eq(tables.workflowStep.workflowId, workflowId));

    const failedKeys = new Set(allSteps.filter((s) => s.status === 'failed').map((s) => s.key));

    // Skip pending steps that depend on failed steps
    for (const s of allSteps) {
      if (s.status !== 'pending') continue;
      const sDeps = (s.dependencies as string[]) ?? [];
      if (sDeps.some((dep) => failedKeys.has(dep))) {
        await db
          .update(tables.workflowStep)
          .set({ status: 'skipped', error: 'Skipped due to failed dependency' })
          .where(eq(tables.workflowStep.id, s.id));
      }
    }

    // Re-check if all steps are now terminal
    const refreshed = await db
      .select()
      .from(tables.workflowStep)
      .where(eq(tables.workflowStep.workflowId, workflowId));

    const allTerminal = refreshed.every((s) =>
      ['completed', 'failed', 'skipped'].includes(s.status)
    );

    if (allTerminal) {
      const firstFailed = refreshed.find((s) => s.status === 'failed');
      const now = new Date().toISOString();
      await db
        .update(tables.workflow)
        .set({
          status: 'failed',
          error: firstFailed?.error ?? 'One or more steps failed',
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(tables.workflow.id, workflowId));

      logger.info('Workflow failed', { workflowId });
    }
  }

  /**
   * Cancel a running workflow.
   */
  async function cancelWorkflow(
    workflowId: number
  ): Promise<Result<void, WorkflowError>> {
    const workflow = await db
      .select()
      .from(tables.workflow)
      .where(
        and(
          eq(tables.workflow.id, workflowId),
          eq(tables.workflow.tenantId, tenantId),
        )
      )
      .then((rows) => rows[0]);

    if (!workflow) {
      return { ok: false, error: { key: 'workflow_not_found', message: `Workflow ${workflowId} not found` } };
    }

    if (workflow.status !== 'pending' && workflow.status !== 'running') {
      return { ok: true, value: undefined };
    }

    const now = new Date().toISOString();

    await db
      .update(tables.workflowStep)
      .set({ status: 'skipped', error: 'Workflow cancelled' })
      .where(
        and(
          eq(tables.workflowStep.workflowId, workflowId),
          eq(tables.workflowStep.status, 'pending')
        )
      );

    await db
      .update(tables.workflow)
      .set({ status: 'cancelled', completedAt: now, updatedAt: now })
      .where(eq(tables.workflow.id, workflowId));

    logger.info('Workflow cancelled', { workflowId });
    return { ok: true, value: undefined };
  }

  /**
   * Get the full status of a workflow including all steps.
   */
  async function getWorkflowStatus(
    workflowId: number
  ): Promise<Result<WorkflowStatusResult, WorkflowError>> {
    const workflow = await db
      .select()
      .from(tables.workflow)
      .where(
        and(
          eq(tables.workflow.id, workflowId),
          eq(tables.workflow.tenantId, tenantId),
        )
      )
      .then((rows) => rows[0]);

    if (!workflow) {
      return { ok: false, error: { key: 'workflow_not_found', message: `Workflow ${workflowId} not found` } };
    }

    const steps = await db
      .select()
      .from(tables.workflowStep)
      .where(eq(tables.workflowStep.workflowId, workflowId));

    return {
      ok: true,
      value: mapWorkflowToStatusResult(workflow, steps),
    };
  }

  /**
   * List workflows for a tenant with optional filtering.
   */
  async function listWorkflows(
    filters?: { status?: WorkflowStatus; type?: string; entityRef?: string; limit?: number }
  ): Promise<Result<WorkflowStatusResult[], WorkflowError>> {
    const conditions = [eq(tables.workflow.tenantId, tenantId)];

    if (filters?.status) {
      conditions.push(eq(tables.workflow.status, filters.status));
    }
    if (filters?.type) {
      conditions.push(eq(tables.workflow.type, filters.type));
    }
    if (filters?.entityRef) {
      conditions.push(eq(tables.workflow.entityRef, filters.entityRef));
    }

    const workflows = await db
      .select()
      .from(tables.workflow)
      .where(and(...conditions))
      .limit(filters?.limit ?? 50)
      .orderBy(sql`${tables.workflow.createdAt} DESC`);

    const results: WorkflowStatusResult[] = [];
    for (const w of workflows) {
      const steps = await db
        .select()
        .from(tables.workflowStep)
        .where(eq(tables.workflowStep.workflowId, w.id));
      results.push(mapWorkflowToStatusResult(w, steps));
    }

    return { ok: true, value: results };
  }

  /**
   * Type-safe workflow start with input validation.
   * Duck-types on { inputSchema, definition } — accepts any TypedWorkflow.
   */
  function start<TInput extends Record<string, unknown>>(
    workflow: { inputSchema: z.ZodType<TInput>; definition: WorkflowDefinition },
    input: TInput,
    options?: { entityRef?: string }
  ): Promise<Result<WorkflowCreatedResult, WorkflowError>> {
    const parsed = workflow.inputSchema.parse(input);
    return startWorkflow(workflow.definition, parsed, options);
  }

  /**
   * Handle a step that has exhausted all queue retries and landed in the DLQ.
   * Marks the step as failed (if not already terminal) and checks if the workflow should fail.
   */
  async function handleStepExhausted(
    workflowId: number,
    stepId: number,
    errorMessage: string
  ): Promise<void> {
    const step = await db
      .select()
      .from(tables.workflowStep)
      .where(
        and(
          eq(tables.workflowStep.id, stepId),
          eq(tables.workflowStep.workflowId, workflowId),
        )
      )
      .then((rows) => rows[0]);

    if (!step || ['completed', 'failed', 'skipped'].includes(step.status)) return;

    await markStepFailed(stepId, workflowId, errorMessage);
    await checkWorkflowFailure(workflowId);
  }

  return {
    validateDefinition,
    startWorkflow,
    start,
    executeStep,
    handleStepExhausted,
    cancelWorkflow,
    getWorkflowStatus,
    listWorkflows,
  };
}

export type WorkflowEngine = ReturnType<typeof createWorkflowEngine>;

// ============================================================================
// Helpers
// ============================================================================

function mapWorkflowToStatusResult(
  workflow: {
    id: number;
    type: string;
    status: string;
    input: unknown;
    output: unknown;
    error: string | null;
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  },
  steps: Array<{
    id: number;
    key: string;
    type: string;
    status: string;
    dependencies: unknown;
    input: unknown;
    output: unknown;
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>
): WorkflowStatusResult<unknown> {
  return {
    id: workflow.id,
    type: workflow.type,
    status: workflow.status as WorkflowStatus,
    input: workflow.input,
    output: workflow.output,
    error: workflow.error,
    totalSteps: workflow.totalSteps,
    completedSteps: workflow.completedSteps,
    failedSteps: workflow.failedSteps,
    steps: steps.map((s) => ({
      id: s.id,
      key: s.key,
      type: s.type,
      status: s.status as WorkflowStepStatus,
      dependencies: (s.dependencies as string[]) ?? [],
      input: s.input,
      output: s.output,
      error: s.error,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    })),
    createdAt: workflow.createdAt,
    startedAt: workflow.startedAt,
    completedAt: workflow.completedAt,
  };
}
