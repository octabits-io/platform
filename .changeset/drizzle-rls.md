---
"@octabits-io/drizzle-toolkit": minor
---

New **`./rls`** subpath — the Postgres row-level-security scoping engine, generic over the GUC key set: `createTenantDb(rawDb, gucs)` (Drizzle proxy wrapping every top-level operation — select/insert/update/delete/execute/transaction/query-namespace — in a short transaction that runs transaction-local `set_config(name, value, true)` first; PgBouncer-safe), `runWithGucs`, `withSystemMode` (GUC name injectable, defaults `app.system_mode`), the pinned-connection model `acquireScopedClient` (with an injected `createDb(client)` factory) / `releaseScopedClient`, and `endPoolGracefully` (pool drain with hard timeout). RLS policies and concrete GUC values stay in the consumer.
