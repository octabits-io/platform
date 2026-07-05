import { z } from 'zod';
import type { Result } from '@octabits-io/foundation/result';
import type { OctError } from '@octabits-io/foundation/result';

// ============================================================================
// Base Job Payload
// ============================================================================

/**
 * Minimal, domain-agnostic constraint for all job payloads.
 *
 * The queue base does not require any specific fields — consumers extend this
 * with their own payload types. Runtime validation is provided per-domain via
 * the Zod schema passed to {@link QueueDomainConfig.schema}.
 */
export type BaseJobPayload = Record<string, unknown>;

/**
 * Loose Zod schema matching {@link BaseJobPayload}.
 *
 * Consumers should pass their own concrete schema to `createQueueDomain`; this
 * is exported mainly as a default/base for building on.
 */
export const SCHEMA_BASE_JOB_PAYLOAD = z.record(z.string(), z.unknown());

// ============================================================================
// Recommended Payload Bases (opt-in)
// ============================================================================

/**
 * Recommended base payload for system/global jobs — jobs that are not scoped
 * to any tenant (cron sweeps, reconciliation, cross-tenant maintenance).
 *
 * NOT required by the queue base. Use this instead of forcing a sentinel
 * tenant id (e.g. `'__system__'`) through a tenant-shaped payload: a job that
 * iterates all tenants simply has no `tenantId`. Compose it with
 * `.extend(...)` to build concrete payload schemas.
 *
 * @example
 * const SCHEMA_RECONCILE_JOB = SCHEMA_SYSTEM_JOB_PAYLOAD.extend({ since: z.string() });
 */
export const SCHEMA_SYSTEM_JOB_PAYLOAD = z.object({
  /** Optional correlation ID for tracing */
  correlationId: z.string().optional(),
});

export type SystemJobPayload = z.infer<typeof SCHEMA_SYSTEM_JOB_PAYLOAD>;

/**
 * Recommended base payload for multi-tenant consumers.
 *
 * NOT required by the queue base — provided as a convenience so multi-tenant
 * callers (e.g. per-request tenant isolation) can extend a shared shape rather
 * than re-declaring `tenantId`/`correlationId` on every queue. Compose it with
 * `.extend(...)` to build concrete payload schemas. For jobs that are global
 * by nature, extend {@link SCHEMA_SYSTEM_JOB_PAYLOAD} instead of inventing a
 * sentinel tenant id.
 *
 * @example
 * const SCHEMA_EMAIL_JOB = SCHEMA_TENANT_JOB_PAYLOAD.extend({ to: z.string().email() });
 */
export const SCHEMA_TENANT_JOB_PAYLOAD = SCHEMA_SYSTEM_JOB_PAYLOAD.extend({
  /** Tenant ID for multi-tenant isolation */
  tenantId: z.string().min(1),
});

export type TenantJobPayload = z.infer<typeof SCHEMA_TENANT_JOB_PAYLOAD>;

// ============================================================================
// Job Context (abstraction over pg-boss job)
// ============================================================================

/**
 * Abstraction over pg-boss job for handler functions.
 * This decouples handlers from the pg-boss implementation.
 */
export interface JobContext<TPayload extends BaseJobPayload> {
  /** Job ID assigned by pg-boss */
  id: string;
  /** Queue name */
  name: string;
  /** Job payload data */
  data: TPayload;
  /** Number of retry attempts so far (0 on the first attempt). */
  retryCount: number;
}

// ============================================================================
// Queue Domain Configuration
// ============================================================================

/**
 * Configuration for creating a queue domain.
 * Note: pg-boss instance is passed via deps, not config.
 */
export interface QueueDomainConfig<TPayload extends BaseJobPayload> {
  /** Queue name (e.g., 'email', 'calendar-sync') */
  name: string;
  /** Dead letter queue name */
  dlq: string;
  /** Zod schema for validating job payloads at runtime */
  schema: z.ZodType<TPayload>;
  /** Number of retries before moving to DLQ (default: 3) */
  retryLimit?: number;
  /** Delay between retries in seconds (default: 10) */
  retryDelay?: number;
  /** Job expiration time in seconds (default: 60) */
  expireInSeconds?: number;
}

// ============================================================================
// Queue Domain Interface
// ============================================================================

/**
 * Interface returned by createQueueDomain factory.
 * All methods return Result<T, E> following codebase patterns.
 */
export interface QueueDomain<TPayload extends BaseJobPayload> {
  /** Enqueue a job for processing */
  enqueue(payload: TPayload): Promise<Result<QueuedJob, EnqueueError>>;
  /** Start the worker to process jobs */
  startWorker(
    handler: JobHandler<TPayload>,
    options?: WorkerOptions
  ): Promise<Result<void, QueueError>>;
  /** Schedule a recurring job */
  schedule(name: string, cron: string, payload: TPayload): Promise<Result<void, EnqueueError>>;
  /** Stop the worker gracefully */
  stop(): Promise<void>;
}

/**
 * Job handler function type.
 * Returns Result to indicate success/failure without throwing.
 */
export type JobHandler<TPayload extends BaseJobPayload> = (
  job: JobContext<TPayload>
) => Promise<Result<void, JobFailedError>>;

export interface WorkerOptions {
  /**
   * Number of jobs fetched per poll (default: 1). Jobs are processed
   * sequentially within the batch, but each job is acked **individually**
   * (pg-boss `perJobResults`) — one failing job does not fail or retry its
   * batch-mates.
   */
  batchSize?: number;
  /** How often pg-boss polls for new jobs, in seconds (default: 2) */
  pollingIntervalSeconds?: number;
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result of enqueueing a job.
 */
export interface QueuedJob {
  /** Job ID assigned by pg-boss */
  jobId: string;
  /** Queue name */
  queue: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error returned by queue operations (enqueue, startWorker, schedule).
 */
export interface QueueError extends OctError {
  key: 'queue_error';
  message: string;
  /** Queue name where the error occurred */
  queue?: string;
}

/**
 * Error returned by job handlers when processing fails.
 */
export interface JobFailedError extends OctError {
  key: 'job_failed';
  message: string;
  /** Job ID that failed */
  jobId?: string;
  /** Queue name where the job failed */
  queue?: string;
  /** Original error cause */
  cause?: unknown;
}

/**
 * Error returned when payload validation fails.
 *
 * On the enqueue/schedule path this is returned to the caller (fail fast, with
 * structured Zod issues). On the worker path an invalid payload is routed
 * straight to the DLQ since retrying won't help.
 */
export interface PayloadValidationError extends OctError {
  key: 'payload_validation_error';
  message: string;
  /** Job ID with invalid payload */
  jobId?: string;
  /** Queue name */
  queue?: string;
  /** Zod validation issues */
  issues?: z.core.$ZodIssue[];
}

/** Union returned by the enqueue-side operations (`enqueue` / `schedule`). */
export type EnqueueError = QueueError | PayloadValidationError;
