---
"@octabits-io/storage": minor
---

Add `@octabits-io/storage`: tenant-namespaced blob storage contract
(`ObjectStorageService`) plus providers. The root entry is dependency-light
(contract, data/error types, and the in-memory picsum dev/mock provider);
vendor-backed providers live behind subpaths — `@octabits-io/storage/s3`
(S3-compatible, optional peer `@aws-sdk/client-s3`) and
`@octabits-io/storage/postgres` (blob-in-Postgres provider + framework-agnostic
HTTP serve handlers, optional peer `drizzle-orm`). Extracted from
reynt-core `platform/storage`; the Postgres provider is generalized to accept
any standard drizzle-orm `PgDatabase` rather than a host-specific schema.
