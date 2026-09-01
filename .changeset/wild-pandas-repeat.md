---
'@octabits-io/framework': minor
---

queue: expose pg-boss's `reindex` and `reindexIntervalSeconds` on `createBossManager`

pg-boss 12.29 turned index-bloat rebuilds (`REINDEX INDEX CONCURRENTLY` on
indexes failing a density check) on by default. `BossManagerConfig` declared a
closed set of options, so a consumer going through the manager — rather than
constructing `PgBoss` directly — had no way to opt out or tune the thresholds,
and every `role: 'full'` process is a candidate for the pass.

Both keys are spread conditionally: pg-boss validates them with `'key' in
config`, so passing them through as `undefined` would trip its config assert
instead of falling back to the default. Omitting them keeps pg-boss's defaults
exactly as before.
