---
'@octabits-io/drizzle-toolkit': minor
---

New **`./testing`** subpath — the former `@octabits-io/drizzle-test` package merged in as a dev-only module (that package is now deprecated in favor of this subpath):

- `createGlobalSetup` / `setupTestDatabase` / `cleanupTestDatabase` / `resetDatabase` — Testcontainers-backed Postgres integration-test harness with Drizzle migrations and per-test truncation.
- `unusedService<T>(name)` — a typed throwing-proxy stub for constructor dependencies a test never exercises. Any property access throws an error naming the stub, so a forgotten real dependency fails loudly instead of surfacing as an opaque `undefined is not a function`.

`testcontainers`, `@testcontainers/postgresql`, and `vitest` are **optional** peer dependencies — only needed when the `./testing` subpath is imported.
