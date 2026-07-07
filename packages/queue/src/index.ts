/**
 * @octabits-io/queue
 *
 * pg-boss-backed queue base layer: a lifecycle/monitoring facade
 * (`createBossManager`) plus a generic queue/worker/DLQ trio with
 * Zod-validated payloads (`createQueueDomain`).
 *
 * Domain-agnostic — the logger is injected and payload types are supplied by
 * the consumer. Partition-scoped callers can build on the recommended
 * `SCHEMA_SCOPED_JOB_PAYLOAD`; global/cron jobs on `SCHEMA_SYSTEM_JOB_PAYLOAD`
 * (no sentinel scope keys).
 */

// Lifecycle / monitoring facade
export { createBossManager } from './BossManager.ts';
export type { BossManager, BossManagerConfig } from './BossManager.ts';

// Generic queue domain factory
export { createQueueDomain } from './createQueueDomain.ts';
export type { CreateQueueDomainDeps } from './createQueueDomain.ts';

// Declarative queue factory (worker + enqueuer + DLQ trio over createQueueDomain)
export { defineQueue } from './defineQueue.ts';
export type {
  DefineQueueOptions,
  QueueDefinition,
  QueueScope,
  QueueScopeFactory,
  DlqAuditRecord,
  DlqAuditSink,
} from './defineQueue.ts';

// Payload + domain types
export {
  SCHEMA_BASE_JOB_PAYLOAD,
  SCHEMA_SYSTEM_JOB_PAYLOAD,
  SCHEMA_SCOPED_JOB_PAYLOAD,
} from './types.ts';
export type {
  BaseJobPayload,
  SystemJobPayload,
  ScopedJobPayload,
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
