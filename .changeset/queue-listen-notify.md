---
"@octabits-io/framework": minor
---

queue: wake workers over LISTEN/NOTIFY. `createBossManager` now starts pg-boss with `useListenNotify: true` under role `'full'` (and explicitly `false` under `'producer'`, which runs no workers). A queue opts in with the new `notify: true` in `QueueDomainConfig` / `defineQueue({ config })`: every send on that queue then emits a Postgres NOTIFY in the same transaction as the insert, and workers fetch immediately instead of waiting out `pollingIntervalSeconds`. Polling continues as the correctness floor; when the listener cannot be established pg-boss warns and keeps polling. Requires the direct database URL (no PgBouncer transaction pooling) — which the pg-boss connection already needed.
