# @octabits-io/storage

## 0.5.0

### Minor Changes

- [`513571d`](https://github.com/octabits-io/platform/commit/513571d069bac7ebd52234fcaf154aa8b1e8e315) - Security and correctness fixes from review:

  - **Path traversal enforced in the request path**: every serve handler (`createExpressHandler`, `createNitroHandler`, `createWebResponse`, `createGenericHandler`, via `getObjectData`) now rejects keys with traversal segments (plain or percent-encoded `..`), leading slashes, or empty keys with a 400 `invalid_key` error before touching storage; `parseStoragePath` percent-decodes and validates keys. The S3 provider additionally rejects `..`/leading-slash keys in `uploadObject`/`deleteObject`/`getObjectData` (`invalid_key`) as defense-in-depth against namespace-prefix escapes via CDN/browser URL normalization.
  - **BEHAVIOR CHANGE (safety)**: `deleteObjectsByPrefix` now requires a non-empty `prefix` in BOTH providers and returns an `invalid_prefix` error otherwise. Previously a missing/empty prefix silently deleted the entire namespace (or, on S3 without a namespace, the entire bucket). Audit callers that relied on prefix-less bulk deletion.
  - **S3 `listObjects` pagination fixed**: the returned `continuationToken` is now `NextContinuationToken` (was the request echo, so results were silently capped at 1000); new optional `continuationToken` and `maxKeys` inputs are plumbed to `ListObjectsV2` (additive; the Postgres provider still returns a single page).
  - **S3 `uploadObject` now sets `ContentType`** from `metadata['content-type']`/`['contentType']` (fallback `application/octet-stream`), matching the Postgres provider — previously the content type landed only as `x-amz-meta-*` and objects served as the S3 default.
  - Serve handlers always emit `X-Content-Type-Options: nosniff`; new optional `ServeHandlerOptions.contentDisposition` on every handler factory (default unset; recommended `'attachment'` for untrusted uploads — inline same-origin SVG/HTML is a stored-XSS vector).
  - S3 `listObjects({ includeHead: true })` correctly applies the documented `application/octet-stream` / `{}` fallbacks when `HeadObject` fails (the failure shape was previously undetected, leaving `metadata`/`contentType` undefined) and uses the fetched `ContentLength` for `size`.
  - S3 `NoSuchBucket` now maps to the dedicated `not_found_bucket` error key (was `not_found`).
  - Postgres provider: new `autoCreateTable` option (default `true`, unchanged) to disable runtime DDL when the table is managed by migrations, and `advisoryLockId` to override the bootstrap advisory-lock id (default 123456789). With `autoCreateTable: true`, first-use reads require DDL privileges — now documented.
  - `ObjectStorageError` gained the `invalid_key` and `invalid_prefix` keys; `ServeObjectError` gained `invalid_key`.

- [`01051db`](https://github.com/octabits-io/platform/commit/01051dbe171b2831b015d5d1cb95ddaeadf2aaf8) - BREAKING: the Postgres blob provider (`@octabits-io/storage/postgres`) is rewritten on raw `pg` instead of the drizzle query builder.

  - **Config takes a `pg` `Pool`.** Both `createPostgresObjectStorageService` and `createPostgresObjectStorageUrlProvider` now accept `{ pool }` (unifying the old `drizzle:`/`db:` split). Pass a `pg` `Pool` instead of a drizzle instance.
  - **Peer swap:** the optional peer `drizzle-orm` is replaced by `pg` (`^8.22.0`, optional). Install `pg` (and `@types/pg` as a dev dep) for the provider; drop `drizzle-orm` if it was only used here.
  - **`objectStorageTable` and `StorageDrizzle` are removed.** Migration-managed setups use the new exported `objectStorageDdl()` — it emits the `object_storage` table, both indexes, and the `object_storage_namespace_key_unique` constraint — then pass `autoCreateTable: false`.
  - **Uploads are now a single `INSERT … ON CONFLICT (namespace, key) DO UPDATE` upsert** (also fixing the previous select-then-write race). This **requires** the `(namespace, key)` unique constraint: the default bootstrap adds it automatically, but a legacy table with `autoCreateTable: false` that lacks it fails uploads with a pointed `internal_error` (apply `objectStorageDdl()` or enable `autoCreateTable`).
  - **`getObjectData().value.lastModified` is now an ISO 8601 string** (e.g. `2026-01-02T03:04:05.000Z`), normalized from the `pg` `Date`. Still a string; format only.

## 0.4.0

### Minor Changes

- [`691c2fc`](https://github.com/octabits-io/platform/commit/691c2fcfefacee90b0ef2beb519fec3a5b83d108) - Remove the picsum provider (breaking): `createPicsumObjectStorageService`,
  `createPicsumObjectStorageUrlProvider`, and their config/service types are no
  longer exported from the root entry. The picsum provider was dev/seeding
  tooling, not a real storage backend — the contract is small enough to fake
  with a Map-backed in-memory implementation in your own test utilities (or
  copy the provider from git history). The root entry is now dependency-free:
  contract and types only.

## 0.3.1

### Patch Changes

- Doc-comment cleanup: replace references to a specific consumer app with generic phrasing in the health, mcp, and Postgres storage provider docs. No behavior change.

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

- [`564b835`](https://github.com/octabits-io/platform/commit/564b835f9afdfa74adf8ae5dcee82cdf74d9a64c) - Add `@octabits-io/storage`: tenant-namespaced blob storage contract
  (`ObjectStorageService`) plus providers. The root entry is dependency-light
  (contract, data/error types, and the in-memory picsum dev/mock provider);
  vendor-backed providers live behind subpaths — `@octabits-io/storage/s3`
  (S3-compatible, optional peer `@aws-sdk/client-s3`) and
  `@octabits-io/storage/postgres` (blob-in-Postgres provider + framework-agnostic
  HTTP serve handlers, optional peer `drizzle-orm`). Extracted from
  reynt-core `platform/storage`; the Postgres provider is generalized to accept
  any standard drizzle-orm `PgDatabase` rather than a host-specific schema.
