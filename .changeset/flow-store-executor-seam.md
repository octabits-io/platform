---
"@octabits-io/flow": minor
---

Add an injectable `SqlExecutor` seam to the Postgres `WorkflowStore` plus a `./store-pg/schema` Drizzle column-set subpath, so a consumer can host the flow tables in its own schema, migrations, and Row Level Security instead of applying a copied DDL blob.

- **`SqlExecutor` + `createWorkflowStore({ exec, partitionKey, schema })`** — the store now addresses all SQL through an injected executor instead of opening its own pool connections. Because the executor owns the transactions, a host can inject one that sets a transaction-local tenant GUC, so the engine's own `createWorkflow`/`completeStep`/… transactions run under RLS. `poolExecutor(pool)` is the batteries-included executor (top-level queries autocommit; `transaction` wraps `BEGIN`/`COMMIT`/`ROLLBACK`).
- **`createPgWorkflowStore(deps)` is unchanged** — it now delegates to `createWorkflowStore` over a `poolExecutor(deps.pool)`. Same signature, same behavior (verified against the full integration suite); existing callers need no change.
- **`@octabits-io/flow/store-pg/schema`** — spreadable Drizzle column-sets (`flowWorkflowColumns`, `flowWorkflowStepColumns`, `flowStepEventColumns`, `flowRateBucketColumns`, `flowStepLeaseColumns`) mirroring `flowStoreDdl()`/`flowEventDdl()`/`flowGateDdl()`. Following the `drizzle-toolkit/scope` precedent they ship columns only; the required indexes/uniques/PKs/FKs — notably the partial-unique `flow_workflow_idempotency_idx` that `createWorkflow`'s `ON CONFLICT` targets — are documented as a copy-paste snippet for the consumer to own.
- `drizzle-orm` is added as an **optional** peer dependency, needed only by the new `./store-pg/schema` subpath; the raw-`pg` store bundle does not import it.

The pg-boss dispatcher, `createPgEventSink`, and `createPgStepGate` still take a `Pool` directly — threading the executor seam through them is a follow-up.
