import type { z } from 'zod';
import { type Result, ok, err } from '@octabits-io/foundation/result';
import type { ServiceResolver } from '@octabits-io/foundation/ioc';
import type {
  StepHandler,
  StepError,
  StepExecutionContext,
  StepHandlerRegistry,
  WorkflowDefinition,
} from './types.ts';
import type { WorkflowEngine } from './engine.ts';

// ============================================================================
// Types
// ============================================================================

/**
 * A type-safe step definition with Zod validation schemas.
 * Created by `defineStep()`, consumed by `buildTypedWorkflow()`.
 */
export interface TypedStep<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
  TDeps extends Record<string, TypedStep<any, any, any>> = {},
> {
  readonly type: string;
  readonly workflowInputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly dependencies: TDeps;
  /** Untyped handler for registry compatibility */
  readonly handler: StepHandler;
}

/** Extract the output type from a typed step */
export type StepOutput<T> = T extends TypedStep<any, infer O, any> ? O : never;

/** Derive the aggregated workflow output from the steps map: { [stepKey]: stepOutput } */
export type WorkflowOutput<TSteps extends Record<string, TypedStep<any, any, any>>> = {
  [K in keyof TSteps]: StepOutput<TSteps[K]>;
};

/**
 * Typed execution context passed to step handlers.
 * `workflowInput` is parsed via `workflowInputSchema`.
 * `deps` entries are parsed via each dependency's `outputSchema`.
 *
 * Generic over TServices so consumers can inject their own service types.
 */
export interface TypedStepContext<
  TInput extends Record<string, unknown>,
  TDeps extends Record<string, TypedStep<any, any, any>>,
  TServices = Record<string, unknown>,
> {
  workflowId: number;
  stepId: number;
  stepKey: string;
  tenantId: string;
  workflowInput: TInput;
  stepInput: Record<string, unknown>;
  deps: { [K in keyof TDeps]: StepOutput<TDeps[K]> };
  signal?: AbortSignal;
  /** Typed IoC container from the request scope. Available in production, may be undefined in tests. */
  container?: ServiceResolver<TServices>;
}

interface DefineStepConfig<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
  TDeps extends Record<string, TypedStep<any, any, any>>,
  TServices = Record<string, unknown>,
> {
  type: string;
  workflowInputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  dependencies?: TDeps;
  handler: (ctx: TypedStepContext<TInput, TDeps, TServices>) => Promise<TOutput>;
  /**
   * Optional: determines if an error is retryable.
   * Defaults to checking for rate limits, network issues, and service unavailability.
   */
  isRetryableError?: (error: unknown) => boolean;
}

// ============================================================================
// Default retryable error detection
// ============================================================================

/**
 * Default implementation for detecting retryable errors (rate limits, network timeouts, etc.)
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();

  // Rate limit errors
  if (message.includes('rate limit') || message.includes('429') || message.includes('too many requests')) {
    return true;
  }

  // Network/timeout errors
  if (message.includes('timeout') || message.includes('econnreset') || message.includes('fetch failed')) {
    return true;
  }

  // Service unavailable
  if (message.includes('503') || message.includes('service unavailable')) {
    return true;
  }

  return false;
}

// ============================================================================
// defineStep
// ============================================================================

/**
 * Define a type-safe workflow step with Zod validation.
 *
 * Wraps a typed handler into an untyped `StepHandler` with a 5-phase validation pipeline:
 * 1. Parse `workflowInput` against `workflowInputSchema`
 * 2. Parse each dependency output against its `outputSchema`
 * 3. Build typed context
 * 4. Call handler
 * 5. Parse output against `outputSchema`
 *
 * All validation errors are non-retryable (schema mismatch = programming error).
 */
export function defineStep<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
  TDeps extends Record<string, TypedStep<any, any, any>> = {},
  TServices = Record<string, unknown>,
>(config: DefineStepConfig<TInput, TOutput, TDeps, TServices>): TypedStep<TInput, TOutput, TDeps> {
  const {
    type,
    workflowInputSchema,
    outputSchema,
    dependencies,
    handler,
    isRetryableError: customIsRetryable,
  } = config;
  const deps = (dependencies ?? {}) as TDeps;
  const checkRetryable = customIsRetryable ?? isRetryableError;

  const wrappedHandler: StepHandler = async (
    ctx: StepExecutionContext
  ): Promise<Result<Record<string, unknown>, StepError>> => {
    try {
      // Phase 1: Parse workflow input
      const inputResult = workflowInputSchema.safeParse(ctx.workflowInput);
      if (!inputResult.success) {
        return err({
          key: 'step_error' as const,
          message: `[${type}] Invalid workflow input: ${inputResult.error.message}`,
          retryable: false,
        });
      }

      // Phase 2: Parse dependency outputs
      const parsedDeps: Record<string, unknown> = {};
      for (const [depKey, depStep] of Object.entries(deps)) {
        const depOutput = ctx.dependencyOutputs[depKey];
        const depResult = (depStep as TypedStep).outputSchema.safeParse(depOutput);
        if (!depResult.success) {
          return err({
            key: 'step_error' as const,
            message: `[${type}] Invalid dependency output '${depKey}': ${depResult.error.message}`,
            retryable: false,
          });
        }
        parsedDeps[depKey] = depResult.data;
      }

      // Phase 3: Build typed context
      const typedCtx: TypedStepContext<TInput, TDeps, TServices> = {
        workflowId: ctx.workflowId,
        stepId: ctx.stepId,
        stepKey: ctx.stepKey,
        tenantId: ctx.tenantId,
        workflowInput: inputResult.data,
        stepInput: ctx.stepInput,
        deps: parsedDeps as TypedStepContext<TInput, TDeps, TServices>['deps'],
        signal: ctx.signal,
        container: ctx.container as ServiceResolver<TServices> | undefined,
      };

      // Phase 4: Call typed handler
      const output = await handler(typedCtx);

      // Phase 5: Validate output
      const outputResult = outputSchema.safeParse(output);
      if (!outputResult.success) {
        return err({
          key: 'step_error' as const,
          message: `[${type}] Invalid step output: ${outputResult.error.message}`,
          retryable: false,
        });
      }

      return ok(outputResult.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown step error';
      const retryable = checkRetryable(error);

      return err({
        key: 'step_error' as const,
        message,
        retryable,
      });
    }
  };

  return {
    type,
    workflowInputSchema,
    outputSchema,
    dependencies: deps,
    handler: wrappedHandler,
  };
}

// ============================================================================
// buildTypedWorkflow
// ============================================================================

/**
 * A typed workflow built from `defineStep` step definitions.
 * Provides type-safe `start()`, auto-derived `definition`, and `register()` for the handler registry.
 */
export interface TypedWorkflow<
  TInput extends Record<string, unknown>,
  TSteps extends Record<string, TypedStep<any, any, any>>,
> {
  readonly type: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly definition: WorkflowDefinition;
  /** Register all step handlers with a registry */
  register(registry: StepHandlerRegistry): void;
  /** Type-safe workflow start with input validation */
  start(
    engine: WorkflowEngine,
    input: TInput,
    options?: { entityRef?: string }
  ): ReturnType<WorkflowEngine['startWorkflow']>;
}

interface BuildTypedWorkflowConfig<
  TInput extends Record<string, unknown>,
  TSteps extends Record<string, TypedStep<any, any, any>>,
> {
  type: string;
  inputSchema: z.ZodType<TInput>;
  steps: TSteps;
}

/**
 * Build a typed workflow from step definitions.
 *
 * Derives the `WorkflowDefinition` DAG from step dependency metadata.
 * Validates at construction time that all dependency keys reference valid step keys.
 */
export function buildTypedWorkflow<
  TInput extends Record<string, unknown>,
  TSteps extends Record<string, TypedStep<any, any, any>>,
>(config: BuildTypedWorkflowConfig<TInput, TSteps>): TypedWorkflow<TInput, TSteps> {
  const { type, inputSchema, steps } = config;
  const stepKeys = new Set(Object.keys(steps));

  // Validate dependency references at construction time
  for (const [stepKey, step] of Object.entries(steps)) {
    for (const depKey of Object.keys(step.dependencies)) {
      if (!stepKeys.has(depKey)) {
        throw new Error(
          `[buildTypedWorkflow] Step '${stepKey}' depends on '${depKey}', which is not a valid step key. Valid keys: ${[...stepKeys].join(', ')}`
        );
      }
    }
  }

  // Derive WorkflowDefinition from step metadata
  const definition: WorkflowDefinition = {
    type,
    steps: Object.entries(steps).map(([key, step]) => {
      const depKeys = Object.keys(step.dependencies);
      return {
        key,
        type: step.type,
        ...(depKeys.length > 0 ? { dependencies: depKeys } : {}),
      };
    }),
  };

  return {
    type,
    inputSchema,
    definition,

    register(registry: StepHandlerRegistry): void {
      for (const step of Object.values(steps)) {
        registry.register(step.type, step.handler);
      }
    },

    start(engine, input, options) {
      const parsed = inputSchema.parse(input);
      return engine.startWorkflow(definition, parsed, options);
    },
  };
}
