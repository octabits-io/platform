# @octabits-io/drizzle-test

## 0.2.0

### Minor Changes

- [`ef2238e`](https://github.com/octabits-io/platform/commit/ef2238e3549096c88b3c48e539f5faef4d9d5e30) - Support parallel test-file execution against the shared container: the Postgres container now starts with `max_connections=200` (configurable via new `maxConnections` option on `createGlobalSetup`), and each file's pool is capped at 2 connections (configurable via new `poolMax` option on `setupTestDatabase`).

- Widened peer ranges: `testcontainers` and `@testcontainers/postgresql` to `^11 || ^12`, `vitest` to `^3 || ^4`, `typescript` to `^5 || ^6`.

## 0.1.4

### Patch Changes

- Reorganize monorepo directory structure for open core model and fix CJS export compatibility in foundation

## 0.1.3

### Patch Changes

- Add `ok()` and `err()` Result constructors, standardize naming conventions across all packages

## 0.1.1

### Patch Changes

- [`ebd810d`](https://github.com/octabits-io/platform/commit/ebd810d0057374ef1b534c0a287270b710c3a30d) - Initial release with Result pattern, IoC container, logger, and utilities (foundation); PII encryption with AES-256-GCM and X25519/age hybrid encryption (pii); Drizzle error handling, cursor pagination, and DAG-based workflow engine (drizzle-toolkit); Vitest global setup and per-suite helpers with testcontainers for Drizzle (drizzle-test).
