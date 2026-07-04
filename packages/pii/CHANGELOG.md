# @octabits-io/pii

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
