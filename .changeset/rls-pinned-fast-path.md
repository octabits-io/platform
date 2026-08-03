---
'@octabits-io/framework': minor
---

RLS wire-amplification cut: `createScopedDb`'s single-statement operations
(builder chains, `query.*.find*`, `execute`) now take a pinned-client fast
path that sends `BEGIN; SELECT set_config(...)` as one simple-query packet —
3 round-trips per call instead of 4. `scopedDb.transaction()` /
`runWithGucs` / `withSystemMode` keep the Drizzle-managed transaction
(savepoint-correct for nested callbacks) but now apply all GUCs in a single
merged `set_config` statement, and `acquireScopedClient` likewise combines
BEGIN plus all session vars into one packet. New export: `escapeGucLiteral`
(pg-compatible literal escaping used by the combined packets).
