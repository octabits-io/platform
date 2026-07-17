# @octabits-io/framework

## 0.4.0

### Minor Changes

- [`b57afc7`](https://github.com/octabits-io/platform/commit/b57afc7618acf7f93182713442a92d9728b5e438) - Database error mapping: SQLSTATE-carrying messages, broader code coverage, cause-chain walking

  `withDbErrorHandling` and `handleTransactionError` previously set `message` to the
  outer (Drizzle) error's message — typically just `Failed query: …` — dropping the
  actual PostgreSQL diagnosis that lives on `.cause`. Consumers that only surface
  `.message` (API responses, re-wrapped errors, test output) could not tell a
  deadlock from a unique violation.

  - The mapped `OctDatabaseError.message` is now prefixed with the raw SQLSTATE
    and, when distinct, the PostgreSQL error's own message:
    `[40P01 deadlock detected] Failed query: …`. The structured
    `code`/`constraint` fields are unchanged.
  - `PostgresErrorCode` gains four new mappings: `exclusion_violation` (23P01),
    `insufficient_privilege` (42501, incl. row-level-security policy violations),
    `lock_not_available` (55P03), and `query_canceled` (57014). These previously
    mapped to `unknown`.
  - `extractPgError` now walks the `cause` chain to a bounded depth instead of
    looking exactly one level deep, so a re-wrapped Drizzle error still maps
    instead of rethrowing.

## 0.3.1

### Patch Changes

- [`fc274ea`](https://github.com/octabits-io/platform/commit/fc274ead5423583626444fbd2122db794a1d372f) - `createFlowWorkflowRoutes`: the `/:id` routes' params schema is now loose (`z.looseObject`). The previous strict schema stripped parent path params (e.g. a mounting app's `/tenant/:tenantId`) during validation — before the consumer's request-scope plugin could read them — breaking get/status/cancel/resume for any consumer mounted under a parameterized prefix.

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
