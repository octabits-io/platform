---
'@octabits-io/flow': minor
---

store-pg: thread the injectable `SqlExecutor` seam through the **step gate** and **event sink**, so a host can run *all* flow SQL (store + gate + sink) through one executor — e.g. one that sets a transaction-local tenant GUC, bringing the flow tables under Row Level Security. Previously only `createWorkflowStore` took an executor while the gate and sink hardwired a `pg.Pool`, so a host could not adopt RLS on `flow.*` consistently (the 0.10.0 follow-up called out in that changelog).

- **`createStepGate({ exec, … })`** — executor-backed gate; `createPgStepGate({ pool, … })` is unchanged and now delegates over `poolExecutor(pool)`. The concurrency-lease acquire runs inside `exec.transaction`, preserving the exact prior rollback-on-cap-hit behavior (advisory lock + expired-lease cleanup roll back together when the cap is hit).
- **`createEventSink({ exec, … })`** — executor-backed observer; `createPgEventSink({ pool, … })` unchanged and delegates. `readFlowEvents` now accepts a `Pool | SqlExecutor`, so run-history reads can also run scoped.
- The `SqlExecutor` / `SqlResult` / `poolExecutor` seam moved to a shared `./executor` module (re-exported from `./store` for compatibility) and gained `toExecutor(pool | exec)`.

No behavior change for existing `createPg*` callers (all delegate through `poolExecutor`, verified against the full integration suite). The pg-boss dispatcher still takes a `Pool` directly — it owns its own connections and writes no `flow.*` tables, so it is out of scope for the executor seam.
