/**
 * Queue Monitoring Types
 *
 * Type definitions for job monitoring capabilities including
 * job states, statistics, and error types.
 *
 * Pure types + error factories — no runtime or domain coupling.
 */

// ============================================================================
// Job State Types
// ============================================================================

/** pg-boss job states */
export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';

/** Details of a single job */
export interface JobDetails {
  id: string;
  name: string;
  data: Record<string, unknown>;
  state: JobState;
  retryCount: number;
  retryLimit: number;
  startedOn: string | null;
  completedOn: string | null;
  createdOn: string;
  expireInSeconds: number;
  output: Record<string, unknown> | null;
}

/** Statistics for a single queue */
export interface QueueStats {
  name: string;
  deferredCount: number;
  queuedCount: number;
  activeCount: number;
  totalCount: number;
}

// ============================================================================
// Error Types
// ============================================================================

export interface JobNotFoundError {
  key: 'job_not_found';
  message: string;
  jobId: string;
  queueName: string;
}

export interface QueueNotFoundError {
  key: 'queue_not_found';
  message: string;
  queueName: string;
}

export interface JobCancelError {
  key: 'job_cancel_error';
  message: string;
  jobId: string;
  queueName: string;
}

export type MonitoringError = JobNotFoundError | QueueNotFoundError | JobCancelError;

// ============================================================================
// Error Factories
// ============================================================================

export function createJobNotFoundError(queueName: string, jobId: string): JobNotFoundError {
  return {
    key: 'job_not_found',
    message: `Job ${jobId} not found in queue ${queueName}`,
    jobId,
    queueName,
  };
}

export function createQueueNotFoundError(queueName: string): QueueNotFoundError {
  return {
    key: 'queue_not_found',
    message: `Queue ${queueName} not found`,
    queueName,
  };
}

export function createJobCancelError(
  queueName: string,
  jobId: string,
  reason?: string
): JobCancelError {
  return {
    key: 'job_cancel_error',
    message: reason ?? `Failed to cancel job ${jobId} in queue ${queueName}`,
    jobId,
    queueName,
  };
}
