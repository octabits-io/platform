# @octabits-io/storage

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
