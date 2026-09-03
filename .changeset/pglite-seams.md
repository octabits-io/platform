---
"@octabits-io/framework": minor
---

Embedded-database (PGlite) support through structural seams — no new peer dependency:

- `./queue`: `createBossManager` takes **either** `connectionString` **or** a pg-boss `db` adapter (`fromPglite(pglite)`, `fromDrizzle(…)`, …) plus an optional `backend` profile, so pg-boss can run on an embedded database or a shared connection instead of its own pool.
- `./events/pglite` (new subpath): `createPgliteNotifyListener({ pglite, channel })` — the `EventNotificationListener` for an in-process PGlite instance. Structural on the instance; imports nothing from `@electric-sql/pglite`.
- `./drizzle/broadcast`: `subscribe` accepts a ready `listener` as the alternative to `connectionString`.
- `./storage/postgres` (**breaking**): the config field `pool: Pool` is now `db: Pool | SqlExecutor` — a `pg` Pool still works; any host that can run parameterized SQL and a transaction (PGlite, an RLS-scoped connection) implements the exported `SqlExecutor` seam directly (same shape as octaflow's). `poolExecutor`/`toExecutor` are exported. `getObjectData` now normalizes `bytea` to a `Buffer` whatever the driver returns.
- `./drizzle/scope`: the `bytea` column type normalizes driver values to `Buffer` (PGlite returns a plain `Uint8Array`).
