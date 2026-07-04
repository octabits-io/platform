# @octabits-io/queue

## 0.2.0

### Minor Changes

- [`53db7bc`](https://github.com/octabits-io/platform/commit/53db7bcc18905aa9bd0efc1004eac11ec6d9bab4) - Add `@octabits-io/queue`: a pg-boss-backed queue base layer.

  - `createBossManager` — lifecycle + monitoring facade over a single shared
    pg-boss instance (start/stop/getJobById/getQueues/getQueueStats/cancelJob),
    with an injected logger and configurable maintenance/monitor intervals.
  - `createQueueDomain` — generic queue/worker/DLQ trio with Zod-validated
    payloads (DLQ created first with `retryLimit: 0`, main queue references it via
    `deadLetter`; payloads validated on both enqueue and dequeue). Workers ack
    **per job** (pg-boss `perJobResults`): one failing job never fails or re-runs
    its batch-mates, schema-invalid payloads dead-letter directly (bypassing
    retries), and handlers receive the real `retryCount` (`includeMetadata`).
    `WorkerOptions.batchSize` names the fetch size honestly (jobs are processed
    sequentially within a batch). Enqueue/schedule return a structured
    `PayloadValidationError` (with Zod issues) on validation failure; the
    `EnqueueError` union is exported.
  - Monitoring types + error factories (`JobDetails`, `QueueStats`, `JobState`,
    `createJobNotFoundError`, …).

  Domain-agnostic: payload types are supplied by the consumer, the logger is
  injected, and all methods return `Result<T, E>` from `@octabits-io/foundation`.
  The base payload constraint is `Record<string, unknown>`; multi-tenant callers
  can opt in to the exported `SCHEMA_TENANT_JOB_PAYLOAD` (`{ tenantId, correlationId? }`).

  `@octabits-io/foundation` (static range `>=0.2.0 <1`) and `pg-boss` (`^12`) are
  **peer dependencies**: their types (`Result`, `PgBoss`) are part of this
  package's public API, so the consumer must share a single instance of each — a
  nested copy would make them different type identities and break declaration
  emit in consumers (TS2883).

  Tested with mocked pg-boss (unit) and against real Postgres + pg-boss via
  testcontainers (integration: per-job batch acking, DLQ routing for invalid
  payloads and retry exhaustion, real retry counts).
