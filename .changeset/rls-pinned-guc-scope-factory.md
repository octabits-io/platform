---
'@octabits-io/framework': minor
---

drizzle/rls: `createPinnedGucScopeFactory` — the per-request pinned-transaction scope model (§19 model B). One drizzle-managed transaction per scope: BEGIN + one set_config statement at scope creation, COMMIT/ROLLBACK at `dispose({commit})`, with the transaction-bound db registered as the scope's `db`. Nested `db.transaction()` gets real savepoints; concurrent queries serialize on the scope's one connection; the pool client is held for the scope's lifetime. The async factory plugs into `createRequestScopePlugin`'s promise-accepting `createScope`. `ScopeChild` gains `onDispose` (the ioc scope always had it).
