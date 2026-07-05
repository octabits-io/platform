# @octabits-io/pii

## 0.6.0

### Minor Changes

- [`691c2fc`](https://github.com/octabits-io/platform/commit/691c2fcfefacee90b0ef2beb519fec3a5b83d108) - Remove the deprecated `TenantKey*` type aliases (breaking): `TenantKeys`,
  `TenantKeyCache`, `TenantKeyDb`, `TenantKeyError`, `TenantKeyNotFoundError`,
  and `TenantKeyGenerationError` are gone — use the `ScopedKey*` equivalents
  (`ScopedKeys`, `ScopedKeyCache`, `ScopedKeyDb`, `ScopedKeyError`,
  `ScopedKeyNotFoundError`, `ScopedKeyGenerationError`). The tenant preset
  itself (`createTenantKeyService`, `TenantKeyService`, `TenantKeyServiceDeps`)
  is unchanged.

## 0.5.0

### Minor Changes

- Split the encryption-key service into a generic core + tenant preset: new `createScopedKeyService` is generic over the scope column (`scope: { column, value }`), and `createTenantKeyService` is now a thin preset over it (`{ column: 'tenantId', value: tenantId }`) with an unchanged deps signature. Breaking: error `key` strings are renamed (`tenant_key_generation_error` → `scoped_key_generation_error`, `tenant_keys_not_found` → `scoped_keys_not_found`) and the not-found error carries `scope` instead of `tenantId`. The old `Tenant*` type names remain as deprecated aliases of the new `Scoped*` types.

## 0.4.0

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

## 0.3.0

### Minor Changes

- [`39e0203`](https://github.com/octabits-io/platform/commit/39e0203b8d27e34e0b623d30aa656ee490cd9c7d) - `createEnvVarMasterKeyProvider` now throws at startup if the master key source is shorter than 32 characters (exported as `MIN_MASTER_KEY_SOURCE_LENGTH`). HKDF does no password stretching, so a short or human-chosen source undermines the derived AES-256 key; the provider now fails fast on misconfiguration instead of silently encrypting under weak key material. Docs updated with generation guidance (`openssl rand -base64 32`). Also fixed a Node `DEP0182` deprecation warning by passing `authTagLength` to `createDecipheriv` in `decryptSymmetric` (no behavioral change).

- [`9650ad6`](https://github.com/octabits-io/platform/commit/9650ad6f7077edbfcff5e956887be9b350f78548) - New **`createTenantKeyService`** — per-tenant Age keypair + blind-index HMAC key management: lazy auto-generation (unique-constraint race-safe), master-key-encrypted storage, cached decryption, `getKeys` / `hasKeys` / `destroyKeys` / cache invalidation. Generic over the storage table (pass the tenant-encryption-key Drizzle table + its `db.query` key — pairs with `@octabits-io/drizzle-toolkit/tenant`) with a structural injected cache. Foundation dep switched from `workspace:^` to `^0.2.0` so the package is consumable via `file:` deps.

## 0.2.0

### Minor Changes

- [`ef2238e`](https://github.com/octabits-io/platform/commit/ef2238e3549096c88b3c48e539f5faef4d9d5e30) - Add raw-bytes encryption for binary payloads (e.g. attachment blobs): low-level `encryptHybridBytes`/`decryptHybridBytes` exports and `encryptBytes`/`decryptBytes` methods on the PII encryption services. Same age hybrid layer as the string variants, but skips text encoding so binary data round-trips without base64 bloat.

  `@octabits-io/foundation` moved from peerDependencies to dependencies (it is a plain utility library — consumers no longer need to install it themselves).

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
