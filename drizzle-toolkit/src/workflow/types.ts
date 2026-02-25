import type { Result, OctError } from '@octabits-io/foundation/result';
import type { ServiceResolver } from '@octabits-io/foundation/ioc';

// ============================================================================
// Status Enums (inline string literal unions — no DB enum dependency)
// ============================================================================

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

// ============================================================================
// Workflow Definition Types
// ============================================================================

/**
 * Declarative workflow definition.
 * Defines a DAG of steps with dependencies for sequential/parallel execution.
 *
 * Example:
 * ```typescript
 * const definition: WorkflowDefinition = {
 *   type: 'listing-enrichment',
 *   steps: [
 *     { key: 'analyze-images', type: 'ai:analyze-images' },
 *     { key: 'analyze-pdf', type: 'ai:analyze-pdf' },
 *     { key: 'generate-description', type: 'ai:generate-text', dependencies: ['analyze-images', 'analyze-pdf'] },
 *     { key: 'optimize-images', type: 'image:optimize', dependencies: ['analyze-images'] },
 *   ],
 * };
 * ```
 */
export interface WorkflowDefinition {
  /** Workflow type identifier (e.g., 'listing-enrichment', 'pdf-processing') */
  type: string;
  /** Ordered list of steps. Steps without dependencies start immediately. */
  steps: StepDefinition[];
}

export interface StepDefinition {
  /** Unique key within the workflow (e.g., 'analyze-pdf', 'generate-description') */
  key: string;
  /** Step handler type - looked up in the step handler registry */
  type: string;
  /** Keys of steps this step depends on. All must complete before this step starts. */
  dependencies?: string[];
  /**
   * Static input for this step.
   * If omitted, the step receives the workflow input + dependency outputs via context.
   */
  input?: Record<string, unknown>;
}

// ============================================================================
// Step Execution Context
// ============================================================================

/**
 * Context passed to step handlers during execution.
 * Provides access to workflow input and outputs from completed dependencies.
 *
 * Generic over TServices so consumers can add their own service dependencies
 * (e.g., AI model provider) without requiring this package to know about them.
 */
export interface StepExecutionContext<TServices = Record<string, unknown>> {
  /** The workflow ID */
  workflowId: number;
  /** The step ID */
  stepId: number;
  /** The step key */
  stepKey: string;
  /** Tenant ID */
  tenantId: string;
  /** Workflow-level input data */
  workflowInput: Record<string, unknown>;
  /** Static step-level input (from definition) */
  stepInput: Record<string, unknown>;
  /** Outputs from completed dependency steps, keyed by step key */
  dependencyOutputs: Record<string, unknown>;
  /** Abort signal for cancellation support */
  signal?: AbortSignal;
  /** IoC container from the request scope. Optional for testing. */
  container?: ServiceResolver<TServices>;
}

// ============================================================================
// Step Handler Types
// ============================================================================

/**
 * A step handler processes a single workflow step.
 * Returns a Result with the step output or an error.
 */
export type StepHandler = (
  ctx: StepExecutionContext
) => Promise<Result<Record<string, unknown>, StepError>>;

export interface StepError extends OctError {
  key: 'step_error';
  message: string;
  /** Whether this error is retryable */
  retryable?: boolean;
}

// ============================================================================
// Step Handler Registry
// ============================================================================

/**
 * Registry for step handlers, mapping step type strings to handler functions.
 * Populated at application startup via IoC.
 */
export interface StepHandlerRegistry {
  register(type: string, handler: StepHandler): void;
  get(type: string): StepHandler | undefined;
  has(type: string): boolean;
  types(): string[];
}

/**
 * Creates a step handler registry.
 */
export function createStepHandlerRegistry(): StepHandlerRegistry {
  const handlers = new Map<string, StepHandler>();

  return {
    register(type: string, handler: StepHandler): void {
      handlers.set(type, handler);
    },
    get(type: string): StepHandler | undefined {
      return handlers.get(type);
    },
    has(type: string): boolean {
      return handlers.has(type);
    },
    types(): string[] {
      return Array.from(handlers.keys());
    },
  };
}

// ============================================================================
// Workflow Status / Result Types
// ============================================================================

export interface WorkflowStatusResult<TOutput = unknown> {
  id: number;
  type: string;
  status: WorkflowStatus;
  input: unknown;
  output: TOutput | null;
  error: string | null;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  steps: WorkflowStepStatusResult[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowStepStatusResult {
  id: number;
  key: string;
  type: string;
  status: WorkflowStepStatus;
  dependencies: string[];
  input: unknown | null;
  output: unknown | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowCreatedResult {
  workflowId: number;
  totalSteps: number;
  /** Steps that were immediately enqueued (no dependencies) */
  enqueuedSteps: string[];
}

// ============================================================================
// Error Types
// ============================================================================

export interface WorkflowNotFoundError extends OctError {
  key: 'workflow_not_found';
  message: string;
}

export interface WorkflowAlreadyRunningError extends OctError {
  key: 'workflow_already_running';
  message: string;
}

export interface InvalidWorkflowDefinitionError extends OctError {
  key: 'invalid_workflow_definition';
  message: string;
}

export interface StepHandlerNotFoundError extends OctError {
  key: 'step_handler_not_found';
  message: string;
  stepType: string;
}

export type WorkflowError =
  | WorkflowNotFoundError
  | WorkflowAlreadyRunningError
  | InvalidWorkflowDefinitionError
  | StepHandlerNotFoundError
  | StepError;
