---
"@octabits-io/drizzle-toolkit": minor
---

Slim the toolkit down to its generic core (breaking):

- **`./tenant`**: removed the ready-built `tenant` / `tenantEncryptionKey` /
  `tenantConfig` tables and their relations. Only the spreadable column-sets
  (`baseTenantColumns`, `tenantEncryptionKeyColumns`, `tenantConfigColumns`)
  and the `bytea` custom type remain — declare the tables (plus FKs, indexes,
  relations) in your own schema so your migrations never depend on a
  library-defined table.
- **`./testing`**: removed the testcontainers-based test utilities
  (`createGlobalSetup`, `setupTestDatabase`, `cleanupTestDatabase`,
  `resetDatabase`, `unusedService`). The module had no consumers; copy it from
  git history if you need it. The `testcontainers` /
  `@testcontainers/postgresql` / `vitest` optional peer dependencies are gone
  with it.
