---
'@octabits-io/flow': minor
---

store-pg: **remove the `@octabits-io/flow/store-pg/schema` Drizzle column-set subpath** (`flowWorkflowColumns`, `flowWorkflowStepColumns`, `flowStepEventColumns`, `flowRateBucketColumns`, `flowStepLeaseColumns`).

BREAKING for anyone importing that subpath — but it had no known consumers: it was added speculatively for a host that ended up defining the flow tables from the DDL blob (`flowStoreDdl()`/`flowGateDdl()`/`flowEventDdl()`) instead. It also shipped columns only, leaving the load-bearing partial-unique idempotency index (`createWorkflow`'s `ON CONFLICT` target) as a copy-paste snippet, and had no test tying the column-sets to the DDL — so the two representations could silently drift.

Removing it drops `drizzle-orm` as an (optional) peer dependency entirely — the raw-`pg` store bundle never imported it. Hosts that want the flow tables in their own Drizzle migrations should model them on the DDL emitted by `flowStoreDdl()` / `flowGateDdl()` / `flowEventDdl()`, which remain the single source of truth. If a real Drizzle-native consumer appears, a column-set subpath can be reintroduced with the constraints exported (not copy-pasted) and a DDL-parity test.
