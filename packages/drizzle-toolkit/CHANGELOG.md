# @octabits-io/drizzle-toolkit

## 0.3.0

### Minor Changes

- [`8c4bdb6`](https://github.com/octabits-io/platform/commit/8c4bdb6e2b3485d3ca3460b0b302d63b10b82868) - New **`./crud`** subpath — `createBaseTenantScopedCrudService`, a generic factory for tenant-scoped CRUD services over any Drizzle table with `id` + `tenantId` columns: paginated `list` (+total), `getById`, `create`, `update`, `delete`, every query auto-scoped with `eq(table.tenantId, tenantId)` from the construction-time tenant. Optional `actorId` stamps `created_by`/`updated_by` audit columns. Structural `CrudDatabase` seam (any augmented Drizzle instance or transaction); errors are `OctDatabaseError` / keyed `ResourceNotFoundError` in foundation `Result`s.

- [`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574) - Add `@octabits-io/drizzle-toolkit/factory` subpath: a generic, schema-parameterized
  Drizzle instance factory. Exports `createDrizzle(schema, { pool, logger })` and
  `createDrizzleFromClient(schema, { client, logger })` which augment a Drizzle
  instance with `.tables` / `.schema` accessors and re-wrap `.transaction()` so the
  tx passed into the callback stays augmented (recursively, for nested savepoints).
  Sets the pg `INT8 → Number` type parser. Also exports the low-level `augmentDrizzle`
  helper and the generic types `AppDatabase<TSchema>`, `AppTransaction<TSchema>`,
  `DbOrTransaction<TSchema>`.

- [`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574) - Add `@octabits-io/drizzle-toolkit/migrate` subpath: `runMigrations({ connectionString,
migrationsFolder, ssl?, logger?, sessionVars? })`. Idempotent Drizzle migration runner
  that connects, optionally applies session GUC variables via `set_config(name, value,
false)` (e.g. `{ 'app.system_mode': 'true' }` to bypass RLS for data migrations), runs
  `migrate()` against the given folder, and always closes the connection.

- [`97ad24e`](https://github.com/octabits-io/platform/commit/97ad24ec9d54e8976d701348d01687d7d1b5838f) - New **`./rls`** subpath — the Postgres row-level-security scoping engine, generic over the GUC key set: `createTenantDb(rawDb, gucs)` (Drizzle proxy wrapping every top-level operation — select/insert/update/delete/execute/transaction/query-namespace — in a short transaction that runs transaction-local `set_config(name, value, true)` first; PgBouncer-safe), `runWithGucs`, `withSystemMode` (GUC name injectable, defaults `app.system_mode`), the pinned-connection model `acquireScopedClient` (with an injected `createDb(client)` factory) / `releaseScopedClient`, and `endPoolGracefully` (pool drain with hard timeout). RLS policies and concrete GUC values stay in the consumer.

- [`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574) - New **`./testing`** subpath — the former `@octabits-io/drizzle-test` package merged in as a dev-only module (that package is now deprecated in favor of this subpath):

  - `createGlobalSetup` / `setupTestDatabase` / `cleanupTestDatabase` / `resetDatabase` — Testcontainers-backed Postgres integration-test harness with Drizzle migrations and per-test truncation.
  - `unusedService<T>(name)` — a typed throwing-proxy stub for constructor dependencies a test never exercises. Any property access throws an error naming the stub, so a forgotten real dependency fails loudly instead of surfacing as an opaque `undefined is not a function`.

  `testcontainers`, `@testcontainers/postgresql`, and `vitest` are **optional** peer dependencies — only needed when the `./testing` subpath is imported.

- [`53db7bc`](https://github.com/octabits-io/platform/commit/53db7bcc18905aa9bd0efc1004eac11ec6d9bab4) - New **`./tenant`** subpath — generic multi-tenant Drizzle schema primitives with zero domain coupling (absorbs the short-lived, never-published `@octabits-io/schema` package):

  - Three base multi-tenant tables — `tenant` (generic `id`/`name`/`isDisabled`/`createdAt` only), `tenantEncryptionKey` (per-tenant Age recipient + encrypted identity + blind-index key; pairs with `@octabits-io/pii`), and `tenantConfig` (`(tenantId, key) → jsonb` store) — plus their Drizzle relations.
  - Spreadable column-sets — `baseTenantColumns`, `tenantEncryptionKeyColumns`, `tenantConfigColumns` — so consumers can extend the base `tenant` with domain columns while reusing the generic core (the documented Drizzle "reuse common column definitions" pattern).
  - `bytea` — a custom `bytea ↔ Buffer` column type for the encrypted key material.

  Uses only `drizzle-orm/pg-core` primitives.

### Patch Changes

- Updated dependencies [[`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574), [`d457103`](https://github.com/octabits-io/platform/commit/d457103625196712bc963f7d49a29ecbbcd42492), [`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574), [`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574)]:
  - @octabits-io/foundation@0.3.0

## 0.2.0

### Minor Changes

- [`ef2238e`](https://github.com/octabits-io/platform/commit/ef2238e3549096c88b3c48e539f5faef4d9d5e30) - Add `@octabits-io/flow` — durable DAG workflow engine (Zod-typed steps, Postgres store, pg-boss dispatcher, optional AI add-on with token/cost/quota instrumentation).

  BREAKING (`@octabits-io/drizzle-toolkit`): the `./workflow` export has been removed; it is superseded by `@octabits-io/flow`. The unused `drizzle-orm` and `zod` peer dependencies were dropped along with it — the remaining `./db` module (error handling, pagination) is unchanged. `@octabits-io/foundation` moved from peerDependencies to dependencies (it is a plain utility library — consumers no longer need to install it themselves).

- Widened `typescript` peer range to `^5 || ^6`.

### Patch Changes

- Updated dependencies [[`ef2238e`](https://github.com/octabits-io/platform/commit/ef2238e3549096c88b3c48e539f5faef4d9d5e30)]:
  - @octabits-io/foundation@0.2.0

## 0.1.4

### Patch Changes

- Reorganize monorepo directory structure for open core model and fix CJS export compatibility in foundation

- Updated dependencies []:
  - @octabits-io/foundation@0.1.4

## 0.1.3

### Patch Changes

- Add `ok()` and `err()` Result constructors, standardize naming conventions across all packages

- Updated dependencies []:
  - @octabits-io/foundation@0.1.3

## 0.1.2

### Patch Changes

- Export missing public API types and utilities from pii and drizzle-toolkit

## 0.1.1

### Patch Changes

- [`ebd810d`](https://github.com/octabits-io/platform/commit/ebd810d0057374ef1b534c0a287270b710c3a30d) - Initial release with Result pattern, IoC container, logger, and utilities (foundation); PII encryption with AES-256-GCM and X25519/age hybrid encryption (pii); Drizzle error handling, cursor pagination, and DAG-based workflow engine (drizzle-toolkit); Vitest global setup and per-suite helpers with testcontainers for Drizzle (drizzle-test).

- Updated dependencies [[`ebd810d`](https://github.com/octabits-io/platform/commit/ebd810d0057374ef1b534c0a287270b710c3a30d)]:
  - @octabits-io/foundation@0.1.1
