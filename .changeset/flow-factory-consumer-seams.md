---
"@octabits-io/framework": minor
---

`./elysia/flow`: consumer seams shaped by the second real consumer. `engine` now also accepts a per-request resolver `(ctx) => FlowEngineReader` for hosts with request-scoped, partition-bound engines; `authorize(action, ctx)` gates each route (return a keyed error — e.g. `forbidden` → 403); `extendWorkflow` gains an optional batched `load(workflows, ctx)` whose result is handed to `project(workflow, loaded)` (side-table joins run once per request, not per row); and map/sub-workflow child steps are now excluded from the wire step list by default (`includeChildSteps: true` opts back in) — children are engine mechanics, same philosophy as flow's status fold. All additive; existing `project(wf)` single-arg callers are unaffected.
