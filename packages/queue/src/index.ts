/**
 * @octabits-io/queue
 *
 * pg-boss-backed queue base layer: a lifecycle/monitoring facade
 * (`createBossManager`) plus a generic queue/worker/DLQ trio with
 * Zod-validated payloads (`createQueueDomain`).
 *
 * Domain-agnostic — the logger is injected and payload types are supplied by
 * the consumer. Multi-tenant callers can build on the recommended
 * `SCHEMA_TENANT_JOB_PAYLOAD`.
 */

// Lifecycle / monitoring facade
export { createBossManager } from './BossManager.ts';
export type { BossManager, BossManagerConfig } from './BossManager.ts';

// Generic queue domain factory
export { createQueueDomain } from './createQueueDomain.ts';
export type { CreateQueueDomainDeps } from './createQueueDomain.ts';

// Payload + domain types
export {
  SCHEMA_BASE_JOB_PAYLOAD,
  SCHEMA_TENANT_JOB_PAYLOAD,
} from './types.ts';
export type {
  BaseJobPayload,
  TenantJobPayload,
  JobContext,
  QueueDomainConfig,
  QueueDomain,
  JobHandler,
  WorkerOptions,
  QueuedJob,
  QueueError,
  JobFailedError,
  PayloadValidationError,
  EnqueueError,
} from './types.ts';

// Monitoring types + error factories
export {
  createJobNotFoundError,
  createQueueNotFoundError,
  createJobCancelError,
} from './monitoring.ts';
export type {
  JobState,
  JobDetails,
  QueueStats,
  JobNotFoundError,
  QueueNotFoundError,
  JobCancelError,
  MonitoringError,
} from './monitoring.ts';
