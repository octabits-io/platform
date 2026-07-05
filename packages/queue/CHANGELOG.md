# @octabits-io/queue

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
