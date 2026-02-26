import { z } from 'zod';
import type { Result, OctError } from '@octabits-io/foundation/result';

// ============================================================================
// Base Job Payload Schema
// ============================================================================

/**
 * Base Zod schema for all job payloads.
 * All queue domains extend this with their specific job types.
 *
 * Using Zod provides runtime validation since payloads come from
 * the database and could be malformed or tampered with.
 */
export const SCHEMA_BASE_JOB_PAYLOAD = z.object({
  /** Tenant ID for multi-tenant isolation */
  tenantId: z.string().min(1),
  /** Optional correlation ID for tracing */
  correlationId: z.string().optional(),
});

export type BaseJobPayload = z.infer<typeof SCHEMA_BASE_JOB_PAYLOAD>;

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
  /** Number of retry attempts so far */
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
  enqueue(payload: TPayload): Promise<Result<QueuedJob, QueueError>>;
  /** Start the worker to process jobs */
  startWorker(
    handler: JobHandler<TPayload>,
    options?: WorkerOptions
  ): Promise<Result<void, QueueError>>;
  /** Schedule a recurring job */
  schedule(
    name: string,
    cron: string,
    payload: TPayload
  ): Promise<Result<void, QueueError>>;
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
  /** Number of concurrent jobs to process */
  concurrency?: number;
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
  key: 'job_failed_error';
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
 * Job will be moved to DLQ since retrying won't help.
 */
export interface PayloadValidationError extends OctError {
  key: 'payload_validation_error';
  message: string;
  /** Job ID with invalid payload */
  jobId?: string;
  /** Queue name */
  queue?: string;
  /** Zod validation issues */
  issues?: z.ZodIssue[];
}
