---
"@octabits-io/drizzle-test": minor
---

Support parallel test-file execution against the shared container: the Postgres container now starts with `max_connections=200` (configurable via new `maxConnections` option on `createGlobalSetup`), and each file's pool is capped at 2 connections (configurable via new `poolMax` option on `setupTestDatabase`).
