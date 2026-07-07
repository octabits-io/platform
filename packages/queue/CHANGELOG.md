# @octabits-io/queue

## 0.4.0

### Minor Changes

- [`ed7813e`](https://github.com/octabits-io/platform/commit/ed7813e8274c1246ab694703d59ced0839b2e5d3) - BREAKING: `SCHEMA_TENANT_JOB_PAYLOAD` → `SCHEMA_SCOPED_JOB_PAYLOAD` and `TenantJobPayload` → `ScopedJobPayload`; the payload field is now `scopeKey` (was `tenantId`). Pairs with `defineQueue`'s `resolveScopeKey` seam; consumers that want a tenant-named field extend `SCHEMA_SYSTEM_JOB_PAYLOAD` with their own.

- [`513571d`](https://github.com/octabits-io/platform/commit/513571d069bac7ebd52234fcaf154aa8b1e8e315) - Queue review fixes — two behavioral bugs and a breaking-ish monitoring API change:

  - **`stop()` was a silent no-op (worker leak).** `createQueueDomain().stop()` and `defineQueue`'s DLQ handler `stop()` called `boss.offWork(workerId)`, but pg-boss v12 `offWork` matches by queue NAME (an id is only accepted via `offWork(name, { id })`) — a worker UUID matched nothing and workers kept polling forever. Both now call `boss.offWork(queueName)`, which stops all workers for the queue; exact since each domain/DLQ handler registers at most one worker (double-start is now guarded).
  - **BREAKING: `BossManager` monitoring methods now return `Result`.** `getJobById`, `getQueues`, `getQueueStats`, and `cancelJob` no longer throw raw pg errors or return `null`/`boolean` — they return `Result<T, E>` using the previously-dead error factories (`job_not_found`, `queue_not_found`, `job_cancel_error`, plus `queue_error` for unexpected throws).
  - **Queue config drift fixed.** pg-boss v12 `createQueue` is `INSERT ... ON CONFLICT DO NOTHING`, so an existing queue kept stale settings (e.g. an old `deadLetter`) forever. The ensure step now calls `boss.updateQueue(name, options)` after `createQueue` (all passed options are updatable; only `policy`/`partition` are immutable and never passed). The dead `'already exists'` error sniff (v12 never throws it) was removed.
  - **Honest DLQ audit records.** `DlqAuditRecord` is now a union discriminated on `validPayload`: valid records keep `payload: TPayload`, `errorMessage: 'Exhausted all retry attempts'`, and `attemptCount` = configured retry limit; schema-invalid records (dead-lettered on the FIRST attempt) carry `rawPayload: unknown`, `errorMessage: 'Payload failed schema validation; dead-lettered without retry'`, and `attemptCount: 1` — no more fabricated retry exhaustion.
  - Double `startWorker()` / DLQ `start()` now returns a `queue_error` Result instead of silently leaking the first registration; `stop()` resets so a restart works.
  - Job failure output now carries JSON-safe error detail: `JobFailedError.cause`/`jobId`/`queue` summaries for handler error Results, and a truncated stack + cause summary for thrown handler errors.
  - DLQ worker tuning: `createDlqHandler(...).start({ pollingIntervalSeconds?, batchSize? })` (defaults unchanged: 30s / pg-boss default batch size); new `DlqWorkerOptions` export.
  - Raw `Result` literals replaced with `ok()`/`err()` from `@octabits-io/foundation/result` (foundation is now a runtime import, per repo convention).
  - `createQueueIfMissing` (never in the package API) was replaced by the internal `ensureQueueSynced` helper.

- [`ed7813e`](https://github.com/octabits-io/platform/commit/ed7813e8274c1246ab694703d59ced0839b2e5d3) - New `defineQueue()` declarative factory: generates worker + enqueuer + DLQ-handler factories from a name, a Zod payload schema, a handler factory, and optional retry/expire config, layered on `createQueueDomain`. DLQ auditing is decoupled from any table schema via an injected `onDlqAudit(scope, record)` sink, and partitioning is a generic `resolveScopeKey` seam (no tenant vocabulary).

## 0.3.0

### Minor Changes

- [`d517615`](https://github.com/octabits-io/platform/commit/d5176151616574ce7e653c3e9b4942b8c8d92f7c) - Make the platform packages tenancy-agnostic: multi-tenancy becomes one way to
  use each API instead of a structural requirement.

  **storage (BREAKING)**: the required per-call `tenant: string` is now an
  optional `namespace?: string` on every `ObjectStorageService` /
  `ObjectStorageUrlProvider` / `ObjectFileServer` method — omit it for
  single-partition deployments. S3 keys default to `<namespace>/<key>` (no more
  hardcoded `tenant/` segment); pass `` namespacePrefix: ns => `tenant/${ns}/`  ``
  on the S3 configs to keep existing bucket layouts. The Postgres provider renames
  its column `tenant_id` → `namespace` (the table initializer migrates existing
  tables in place, data preserved; root namespace stored as `''`), and
  `createPublicUrl` now receives `(namespace: string | undefined, key)`. The
  Postgres HTTP handlers take an optional `namespace` accordingly. Picsum's
  `defaultQuery` placeholder default is now domain-neutral.

  **drizzle-toolkit**: `crud` gains `createBaseCrudService` (no scoping, any
  table with `id`) and `createScopedCrudService` (generic
  `scope: { column, value }` row isolation). `createBaseTenantScopedCrudService`
  is unchanged — now a thin preset of the scoped variant
  (`scope: { column: 'tenantId', ... }`).

  **elysia**: `createMcpRoutes` scope extraction is pluggable via
  `parseScopeKey?: (url) => string | null` (default remains the
  `/tenant/:tenantId/` convention; single-scope servers can pass
  `() => 'default'`). `resolveScope` receives `scopeKey` (with `tenantId` kept
  as a deprecated alias), and `invalidScopeResponse` supersedes the deprecated
  `invalidTenantResponse`. Default rejection message is now "Invalid scope key".

  **queue**: new `SCHEMA_SYSTEM_JOB_PAYLOAD` / `SystemJobPayload` base for
  global/cron jobs — no more `'__system__'` sentinel tenant ids;
  `SCHEMA_TENANT_JOB_PAYLOAD` now extends it.

  **foundation**: `SystemScopeFactory` is partition-agnostic — its parameter is
  an optional `scopeKey?: string` (previously required `tenantId: string`).

  **pii**: `createTenantKeyService` now detects the concurrent key-generation
  race via SQLSTATE 23505 (walking the error `cause` chain) instead of matching
  `'unique'` in error messages; `TenantKeyGenerationError` gains a `conflict`
  flag.

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
