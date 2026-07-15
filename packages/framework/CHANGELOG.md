# @octabits-io/framework

## 0.3.0

### Minor Changes

- [`16796d8`](https://github.com/octabits-io/platform/commit/16796d8c56225e0123bb050282431dd4d18db657) - `./elysia/flow`: consumer seams shaped by the second real consumer. `engine` now also accepts a per-request resolver `(ctx) => FlowEngineReader` for hosts with request-scoped, partition-bound engines; `authorize(action, ctx)` gates each route (return a keyed error — e.g. `forbidden` → 403); `extendWorkflow` gains an optional batched `load(workflows, ctx)` whose result is handed to `project(workflow, loaded)` (side-table joins run once per request, not per row); and map/sub-workflow child steps are now excluded from the wire step list by default (`includeChildSteps: true` opts back in) — children are engine mechanics, same philosophy as flow's status fold. All additive; existing `project(wf)` single-arg callers are unaffected.

## 0.2.0

### Minor Changes

- [`4be8d35`](https://github.com/octabits-io/platform/commit/4be8d359ca260c4fde6e254389248c97550a8fc7) - Add `./elysia/flow`: `createFlowWorkflowRoutes({ engine, … })` serves the generic read/control routes over an `@octabits-io/flow` engine (list, active-probe, get, status snapshot, cancel, resume) using flow's public wire view (`toPublicWorkflow` + `PUBLIC_WORKFLOW_SCHEMA`, flow ≥0.12), with declared response schemas for Eden/OpenAPI, `createErrorMapper`-based error mapping (`errorOverrides`), and an `extendWorkflow: { schema, project }` seam for consumer wire fields. `@octabits-io/flow` is a new optional peer confined to this subpath (same arrangement as `./elysia/mcp`); start/trigger routes remain app-side by design.

## 0.1.0

### Minor Changes

- [`4e0375e`](https://github.com/octabits-io/platform/commit/4e0375ead8429fe14a64bb3fdd16b7868077569c) - Initial release of the merged framework package. Supersedes `@octabits-io/{foundation,elysia,queue,storage,mail}` — imports map 1:1 onto subpaths (`foundation/<module>` → `framework/<module>`, the other four → `framework/<package>[/<sub>]`; see the README's migration table). One package, granular subpath exports, no root export; a boundary lint keeps the app modules (`elysia`, `queue`, `storage`, `mail`) from importing each other and confines each vendor SDK to its module. `elysia` and `pg-boss` are now optional peers (previously required); `zod` is the only required peer.

  Beyond the merge, this first release adds what consumers previously hand-rolled: a per-request IoC scope plugin for Elysia (`createRequestScopePlugin` — guaranteed disposal with commit/rollback semantics, `guard` seam, renameable context key, extras merging), the ioc↔rls bridge (`createGucScopeFactory`) plus `withScope`/`forEachScope` lifecycle helpers and GUC list-value guards, a bearer-auth plugin over the auth module's structural seam, `successResponses` (fixes Eden Treaty narrowing on non-200-success routes), 409/429 error-key conventions with `createErrorMapper`, a rate-limit `errorKey` option, `buildSwaggerOptions`, `assertNotInProduction`, `runElysiaServer`, a `./elysia/testing` subpath (`testRequest`/`testAuthenticatedRequest`), `MAIL_CONFIG_SCHEMA` + `createConfigParser` config fragments, `constantTimeEquals` in `./signing`, and `./drizzle/job-audit-store` (the Drizzle implementation of the queue module's DLQ-audit seam).
