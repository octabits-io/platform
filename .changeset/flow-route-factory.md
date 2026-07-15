---
"@octabits-io/framework": minor
---

Add `./elysia/flow`: `createFlowWorkflowRoutes({ engine, … })` serves the generic read/control routes over an `@octabits-io/flow` engine (list, active-probe, get, status snapshot, cancel, resume) using flow's public wire view (`toPublicWorkflow` + `PUBLIC_WORKFLOW_SCHEMA`, flow ≥0.12), with declared response schemas for Eden/OpenAPI, `createErrorMapper`-based error mapping (`errorOverrides`), and an `extendWorkflow: { schema, project }` seam for consumer wire fields. `@octabits-io/flow` is a new optional peer confined to this subpath (same arrangement as `./elysia/mcp`); start/trigger routes remain app-side by design.
