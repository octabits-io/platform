# @octabits-io/demo-server

A small **contact desk** API that exercises as much of
[`@octabits-io/framework`](../../packages/framework) as is practical in one
service. It has two jobs:

1. **Living documentation** — every route is a worked example of a framework
   module against a real Postgres, not a snippet.
2. **Pre-release validation** — the framework was merged from five packages into
   one subpath-exported package and has not been published yet. This app is the
   consumer that proves the packaging works before it ships.

Private workspace app. Not published, no build step — Bun runs the TypeScript
sources directly.

**Stack note (2026-08-04):** this app runs on **Hono**
(`@octabits-io/framework/hono`), ported from Elysia as the end-to-end proof of
the `./hono` glue module. Nothing outside the glue moved:
every service, container registration, queue, schema and — tellingly — every
test *assertion* is byte-for-byte what it was. The diff is route declarations,
the app skeleton, and `main.ts`'s listen call. The Hono-specific traps found on
the way are collected under
[Notes for framework readers](#hono-specific-new-with-the-2026-08-04-migration).

## Run it

```bash
# 1. Postgres on :5433 (user/password/db all "demo")
docker compose -f apps/demo-server/docker-compose.yml up -d --wait

# 2. From the repo root
pnpm install
pnpm --filter @octabits-io/demo-server dev     # bun --watch
# or: pnpm --filter @octabits-io/demo-server start
```

Then `curl http://localhost:3101/health/ready` → `{"status":"ok","db":"connected"}`.

Zero configuration is required — every value in [`.env.example`](./.env.example)
has a working default, including committed **dev** PII keys. The app refuses to
boot with those keys when `NODE_ENV=production`.

Tables are created at startup with idempotent `CREATE TABLE IF NOT EXISTS` DDL
(see [`src/db/ddl.ts`](./src/db/ddl.ts)). A real service would own migrations via
`@octabits-io/framework/drizzle/migrate` instead. Columns added to an existing
table need their own `ALTER TABLE … ADD COLUMN IF NOT EXISTS` line beside the
`CREATE`: `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already
booted once, so without it the DDL silently drifts from `schema.ts` on every
developer machine but a fresh one.

## Routes

| Method | Path | What it demonstrates |
| --- | --- | --- |
| GET | `/health` `/health/live` | Liveness (`createHealthRoutes`) |
| GET | `/health/ready` | Readiness — runs `SELECT 1`; failure → 503 |
| GET | `/api/contacts?page=&pageSize=` | Paginated list, emails decrypted per row |
| POST | `/api/contacts` | Create — email encrypted + blind-indexed |
| GET | `/api/contacts/search?email=` | Exact-match lookup via the blind index |
| GET | `/api/contacts/:id` | Read one |
| PUT | `/api/contacts/:id` | Update (re-encrypts + re-indexes on email change) |
| — | *(contact fields)* | `wishStart`/`wishEnd`/`wishNights` — the travel wish behind the kit's `FlexiblePeriodInput`; `''` on the wire clears the (nullable) column |
| DELETE | `/api/contacts/:id` | **RBAC-guarded** — `x-demo-role: admin` required |
| POST | `/api/contacts/:id/welcome` | Enqueue a welcome email, idempotent per contact |
| GET | `/api/notes` | List (`createBaseCrudService`) |
| POST | `/api/notes` | Create |
| GET | `/api/notes/:id` | Read one — missing → `note_not_found` → 404 |
| PUT | `/api/notes/:id` | Update |
| — | *(note fields)* | `publicTitle`/`publicBody` — `LocaleMap<string>` jsonb columns, the shape the kit's `LocaleInput`/`LocaleTextarea` edit |
| DELETE | `/api/notes/:id` | Delete |
| POST | `/api/files` | Upload (`multipart/form-data`, field `file`) |
| GET | `/api/files` | List blobs |
| GET | `/api/files/:id` | Download — correct content-type, ETag, 304, `attachment` |
| GET | `/api/settings` | Read settings (schema defaults applied for unset keys) |
| PUT | `/api/settings` | Write settings — **RBAC-guarded** (`admin`) |
| GET | `/api/queue/stats` | pg-boss counts for `welcome-email` + its DLQ |
| POST | `/api/tools/slugify` | `slugify` from `…/utils` |
| GET | `/api/captcha/challenge` | Captcha contract (no-op provider) |
| POST | `/api/captcha/verify` | Redeem a solution → verified token |
| POST | `/api/ai/workflows` | Start the `contact-brief` workflow (`octaflow/ai`); its last step stores a **proposal** as its output |
| POST | `/api/ai/workflows/:id/apply` | Apply a reviewer's `ProposalDecision`: drift guard (409 `proposal_drift`), writes, audit row (`…/proposal` + `ai/proposals.ts`) |
| POST | `/api/ai/workflows/:id/revert` | Undo an application from its audit row (`invertOperations`) |
| GET | `/api/protected/whoami` | **Bearer API-key auth** (`createBearerAuthPlugin` + `…/auth`) — the boot log prints a `demo_…` key once |
| GET | `/openapi.json` | OpenAPI 3.1 spec (`mountOpenApi` + `buildSwaggerOptions`; `ENABLE_SWAGGER=false` to disable both) |
| GET | `/swagger` | Browsable UI (`@hono/swagger-ui`, an app-level choice — the framework takes no UI dep) |

### The one flow worth following

`PUT /api/settings` → `POST /api/contacts/:id/welcome` → the server log.

Writing `welcomeSubject` changes the subject of the *next* welcome mail, because
the mail service's `configReader` seam reads the settings table and returns it as
`subjectOverride` (which wins over the template's own `buildSubject`). The job
crosses a queue, resolves its dependencies from a fresh IoC scope, and lands in
the logger transport — which prints the fully-rendered message instead of
sending it:

```
Mail sent (logger transport) {"from":"Contact Desk via Octabits Demo <noreply@demo.example>",
  "to":"ada@example.com","replyTo":"Contact Desk <help@demo.example>",
  "subject":"Welcome aboard, from settings!", ...}
```

That covers `…/drizzle/config` → `…/mail` → `…/queue` → `…/ioc` in one request.

### Roles

`x-demo-role: admin | viewer`. `viewer` may read everything but cannot delete a
contact or write settings (→ 403). A real app maps the role from a validated JWT
claim; the header keeps the 403 path one curl away.

### CORS

`apps/demo-web` is served from `http://localhost:3100` — a different origin than
this API — so it needs CORS. `cors()` comes from Hono's own `hono/cors` and
goes into `createHonoApp`'s `middleware` array — on Hono there is no plugins
seam to design around, because middleware is just middleware — with
`x-demo-role` in `allowHeaders` and
`etag`/`content-disposition` in `exposeHeaders` so the blob 304s stay readable
cross-origin. Allowed origins come from `CORS_ORIGINS` (CSV, default
`http://localhost:3100`).

Worth stating plainly, because it cost a debugging session: **`curl` does not
enforce the same-origin policy.** Every route here passed `curl` while the SPA
saw nothing but preflight failures. A browser is the only client that tests CORS.

## Framework module coverage

| Subpath | Used in | Covered |
| --- | --- | --- |
| `./result` | Everywhere — every service returns `Result<T, E>` | ✅ |
| `./ioc` | [`container.ts`](./src/container.ts) — service map, `createSystemScope` for the queue worker, and per-request child scopes (`createDemoRequestScope`) with a Scoped `settingsService` override | ✅ |
| `./logger` | [`main.ts`](./src/main.ts) — root logger, childed per component; OTLP export behind `OTLP_LOGS_ENDPOINT`, drained by `loggerService.shutdown()` in the teardown tail | ✅ |
| `./utils` | [`routes/tools.ts`](./src/routes/tools.ts) (`slugify`), `createDateProvider` in the container | ✅ |
| `./config-schema` | [`config.ts`](./src/config.ts) — `DATABASE_CONFIG_SCHEMA`, `LOGGING_CONFIG_SCHEMA`, `MAIL_CONFIG_SCHEMA`, `createConfigParser`, `nonEmptyString/Url` | ✅ |
| `./rbac` | [`rbac.ts`](./src/rbac.ts) — statement matrix + `admin`/`viewer` roles | ✅ |
| `./pii` | [`services/contacts.ts`](./src/services/contacts.ts) — age encryption + HMAC blind index | ✅ |
| `./captcha` | [`routes/tools.ts`](./src/routes/tools.ts) — no-op provider behind the real contract | ✅ |
| `./auth` | [`api-keys.ts`](./src/api-keys.ts) — `createApiKeyFormat` + `createBearerAuthService` behind `/api/protected` (the IdP-free half; JWT validation still needs an IdP) | ✅ |
| `./drizzle/factory` | [`main.ts`](./src/main.ts) — `createDrizzle(schema, { pool })` | ✅ |
| `./drizzle/db` | `withDbErrorHandling`, `normalizePaginationLimit` in the contacts service | ✅ |
| `./drizzle/scope` | [`db/schema.ts`](./src/db/schema.ts) — `scopedConfigColumns`, `bytea` | ✅ |
| `./drizzle/crud` | [`services/notes.ts`](./src/services/notes.ts) — `createBaseCrudService` drives the whole entity, including the two `LocaleMap<string>` jsonb columns (the factory maps columns to fields; a per-locale map needs no seam of its own) | ✅ |
| `./drizzle/backfill` | [`db/backfills.ts`](./src/db/backfills.ts) — `ensureDataMigrationRunsTable` + `runBackfills`, run from `main.ts` between the DDL and the first request. The demo has a real one: `notes.public_title` was added after the table existed, so every older note is seeded from its internal title. Batched at 50 to exercise the partial-run path — a run that leaves rows `pending` is deliberately NOT marked, and the next boot continues; once marked, a boot costs one primary-key lookup (watch the log line change from `processed=…` to `already completed at …`) | ✅ |
| `./drizzle/broadcast` | [`container.ts`](./src/container.ts) + [`routes/settings.ts`](./src/routes/settings.ts) + [`main.ts`](./src/main.ts) — a `demo_settings_changed` channel carrying cache-invalidation *hints*: `PUT /api/settings` publishes after a successful write, the LISTEN side invalidates the cross-scope `settingsCache` (60s TTL, the correctness backstop the hint merely shortens). Deliberately not an event — no envelope, no outbox, no replay; losing one costs staleness, not correctness, which is the whole reason it is a different module from `./events` | ✅ |
| `./drizzle/config` | [`services/settings.ts`](./src/services/settings.ts) — unscoped `createScopedConfigService`, with `createScopedConfigCache` over an `…/utils` LRU (`container.ts`) so reads are cached across requests; the module's documented multi-instance caveat is answered by the broadcast row below | ✅ |
| `./drizzle/idempotency` | `POST /api/contacts/:id/welcome` — `begin()` / `commit()` | ✅ |
| `./server` | [`app.ts`](./src/app.ts) — `buildSwaggerOptions`; [`main.ts`](./src/main.ts) — `runServer` + graceful shutdown (both survived the framework swap **untouched**: the run tail only ever needed a structural `.listen(port)`); [`config.ts`](./src/config.ts) — `getEnv*`, `parseCsv`, `assertNotInProduction`; `errorResponses`/`successResponses` on every route; [`http.ts`](./src/http.ts) — `createErrorMapper` behind this app's `errorJson`; [`app.test.ts`](./src/app.test.ts) runs on `…/server/testing`'s `testRequest` | ✅ |
| `./hono` | [`app.ts`](./src/app.ts) — `createHonoApp`, `createHealthApp`, `createSecurityHeadersMiddleware` (twice: hardened for the API, relaxed for `/swagger` only), `createClientIpMiddleware` + `createRateLimitMiddleware`; [`request-scope.ts`](./src/request-scope.ts) — `createRequestScopeMiddleware`: contacts + settings resolve via `c.get('scope')` (request-seeded `role`, per-request `settingsService` cache), the `guard` rejects unknown roles with `invalid_demo_role` → 400; `createRouteModule` wraps every module that reads a context variable, so a declared `Env` cannot outrun its middleware; `createBearerAuthMiddleware` guards `/api/protected`; `testableHonoApp` bridges the app into the shared test harness | ✅ |
| `./hono/openapi` | Every route in [`routes/`](./src/routes) — `describeApiRoute({ summary, tags, responses })` takes the existing `successResponses`/`errorResponses` zod maps verbatim, and `octApiValidator(target, schema)` replaces Elysia's `body`/`query`/`params` options while serving validation, `c.req.valid()` typing, the spec's request parameters and the standard `validation_error` body from one declaration; [`app.ts`](./src/app.ts) serves the spec via `mountOpenApi` | ✅ |
| `./proposal` | [`ai/workflows.ts`](./src/ai/workflows.ts) (`propose` step — the producer: `proposeFields` with `guard: driftDigest(current)`, `proposeCreate`, `skipped[]`, `provenance`; the proposal is the step's output schema) + [`ai/proposals.ts`](./src/ai/proposals.ts) (the host's half: anchor→table mapping, `validateProposal` → `resolveDecision` → `detectDrift` → writes → audit row in `proposal_applications`; revert via `invertOperations` through the same writes). The reference implementation the contract's docs point at — `docs/proposal.md` "The recipe" | ✅ |
| `./hono/flow` | [`routes/ai.ts`](./src/routes/ai.ts) — `createFlowWorkflowRoutes` serves the generic workflow read/control routes (list/active/get/snapshot/cancel/resume) over flow's public wire view, mounted with `app.route('/workflows', …)` (the Hono factory has no `prefix` option — where you mount it is the prefix); `appliedAt` rides the `extendWorkflow` seam — projected from the `proposal_applications` audit row, batched once per request through `load` — and `ai_quota_exceeded → 429` (plus the `proposal_*` conflicts) via `errorOverrides`. Only the domain trigger route and `/usage` are hand-written. | ✅ |
| `./queue` | [`queues/welcome-email.ts`](./src/queues/welcome-email.ts) — `defineQueue` + `BossManager`; dead letters persist to `job_audit_log` via `…/drizzle/job-audit-store` | ✅ |
| `./storage` + `./storage/postgres` | [`routes/files.ts`](./src/routes/files.ts) — provider + `createWebResponse` + `objectStorageDdl` | ✅ |
| `./mail` | [`services/mail.ts`](./src/services/mail.ts) — `createBaseMailService` + logger transport | ✅ |
| `./events` + `./events/postgres` + `./drizzle/event-outbox` | [`routes/events.ts`](./src/routes/events.ts) — two-lane event fan-out end to end: `eventPublisher.emit(…, tx)` writes the outbox row + NOTIFY at COMMIT (durable) or inline payload (ephemeral); the publisher is typed — [`container.ts`](./src/container.ts) declares the event vocabulary once as Zod schemas (`DEMO_EVENT_SCHEMAS`), derives `DemoEventMap` from it, and passes both to `createEventPublisher<DemoEventMap>({ …, payloadSchemas })` so type/payload mismatches fail at compile time and unregistered types throw at runtime; [`main.ts`](./src/main.ts) runs the dedicated LISTEN connection + relay; `GET /api/events/stream` serves SSE via `app.mount()` (plain fetch handler — no route-type budget, no client types; the browser side is `@octabits-io/nuxt-ui-kit/events`). On Hono this is load-bearing rather than merely tidy: `createRequestScopeMiddleware` disposes its scope *before* the `Response` is returned, so anything long-lived has to live outside it — which `.mount()` gives for free. Try it: open `/events` in demo-web, or `curl -N localhost:3101/api/events/stream` and `POST /api/events/demo` with `{"lane":"durable"}` — reconnect with `Last-Event-ID: 0` to watch the outbox replay. | ✅ |

Honestly not covered here:

> **Real-service coverage lives elsewhere.** The modules below that were skipped
> because they need an external server — `./vault`, `./storage/s3`, `./mail/smtp`,
> and `./zitadel` — are now validated against real backing services (Vault,
> MinIO, Mailpit, Zitadel) in the framework's own **integration suite** via
> testcontainers (`packages/framework/src/<module>/integration.test.ts`). The
> demo stays credential-free and curl-able; the integration tests exercise the
> vendor adapters.

| Subpath | Why not |
| --- | --- |
| `./signing` | No use case here — it signs scoped tokens/tags (e.g. the `<tag>` in a `reply+…` address), which requires the inbound-mail flow below. |
| `./vault` | Boot-time secret loading from HashiCorp Vault. Would need a Vault instance to demo anything real — covered by the framework integration suite instead. |
| `./ical` | No calendar domain in a contact desk. Bolting one on would be filler, not documentation. |
| `./drizzle/rls` | Row-level security is only meaningful with a partitioned schema + policies; this app is single-scope by design. |
| `./drizzle/migrate` | Superseded by boot-time DDL (see above) — a demo has to come up clean against a throwaway container. |
| `./drizzle/scoped-key-store` | Per-scope key management. This app has one age keypair from config, not a key row per scope. |
| `./storage/s3` | Would need real S3-compatible credentials. The Postgres provider satisfies the identical `ObjectStorageService` contract — and the S3 provider has its own MinIO integration test in the framework. |
| `./mail/smtp`, `./mail/mailjet`, `./mail/brevo` | Each pulls a vendor SDK and needs credentials. The logger transport proves the same `MailTransport` contract; these are the drop-in swap. SMTP has a Mailpit integration test in the framework. |
| `./mail` inbound/reply-address | `parseBrevoInbound`, `buildReplyAddress`, `screenInboundAttachment` need a real inbound webhook. |
| `./captcha/altcha` | The no-op provider covers the contract; ALTCHA adds `altcha-lib` and a proof-of-work widget. |
| `./hono/mcp` | Skipped — see below. |
| `./hono/events` | The sub-app wrapper (`app.route('/events', createEventStreamApp(…))`) around the same handler this app mounts directly. `.mount()` is the kit's preferred, fetch-first registration and is load-bearing here (see the `./events` row above), so demoing the wrapper would mean replacing the lesson rather than adding one. It is three lines over `createEventStreamHandler`. |
| `./ioc`'s `withScope`/`forEachScope` | The queue module already owns the worker's scope lifecycle here; a fan-out sweep over one scope would be filler. |
| `./drizzle/rls`'s `createGucScopeFactory` | The ioc↔rls bridge needs RLS policies + a partitioned schema; this app is single-scope by design (same reason as `./drizzle/rls` above). |
| `./server`'s `createErrorMapper` | ~~No domain key→status overrides~~ — now covered: [`http.ts`](./src/http.ts)'s `createErrorJson` binds it, and [`routes/ai.ts`](./src/routes/ai.ts) pre-binds `ai_quota_exceeded → 429`. |
| `./signing`'s `constantTimeEquals` | No inbound webhook to verify. |
| `./drizzle/crud`'s `createScopedCrudService` | The scoped sibling of the factory used here. Needs a scope column; this app is single-scope. |

`./hono/mcp` was left out deliberately: it needs two more optional peers
(`@hono/mcp`, `@modelcontextprotocol/sdk`) and its value is an MCP client
session, which no curl in this README can verify. Mounting it untested would be
worse documentation than omitting it.

## `octaflow` coverage

The durable AI workflow behind `/api/ai/*` consumes the **published**
`octaflow` from npm (not a workspace link — this app also validates
its packaging). One workflow ships: `contact-brief`, a three-step DAG
(`fetch` → `summarize` ∥ `followup`) whose two AI steps run in parallel because
the engine derives that from their dependencies.

| Export | Used in | Covered |
| --- | --- | --- |
| `.` (core) — `createWorkflowEngine`, `defineStep` types via `defineAiStep`, registry, `createInMemoryWorkflowStore`; the public wire view (`toPublicWorkflow`, `PUBLIC_WORKFLOW_SCHEMA`) is consumed indirectly through `…/hono/flow`'s route factory | [`ai/engine.ts`](./src/ai/engine.ts), [`ai/testing.ts`](./src/ai/testing.ts), [`routes/ai.ts`](./src/routes/ai.ts) | ✅ |
| `./ai` — `defineAiStep`, `buildAiWorkflow`, `createAiWorkflowHooks`, `createCostEstimator`, `createAiQuotaService`, `createAiUsageAggregationService` | [`ai/workflows.ts`](./src/ai/workflows.ts), [`ai/engine.ts`](./src/ai/engine.ts), [`ai/runtime.ts`](./src/ai/runtime.ts); the consumer-SQL `AiUsageStore`/`AiUsageRecorder` seams live in [`ai/usage.ts`](./src/ai/usage.ts) over the `ai_*` tables | ✅ |
| `./store-pg` — `createPgWorkflowStore`, `flowStoreDdl` | [`ai/runtime.ts`](./src/ai/runtime.ts); DDL applied in [`db/ddl.ts`](./src/db/ddl.ts) next to `objectStorageDdl()` | ✅ |
| `./dispatcher-pgboss` — dispatcher + step/DLQ workers | [`ai/runtime.ts`](./src/ai/runtime.ts) — on the **same** pg-boss instance `BossManager` owns (`boss.getBoss()`) | ✅ |
| Not covered | `createPgStepGate`/`flowGateDdl` (global concurrency/rate gates), `createPgEventSink`/`flowEventDdl` (run-history timeline), `defineWaitStep`/`defineMapStep`/`defineSubWorkflowStep`/saga compensation, `createPgBossScheduler` (cron starts), `recoverStuckWorkflows` sweeps, 0.17's `when` guards/`join: 'any'`, wait/workflow deadlines, step heartbeats (`heartbeatTimeoutMs`), and `retryWorkflow` — the flow repo's `examples/` cover these | — |

**The model is `MockLanguageModelV4` from `ai/test`** ([`ai/model.ts`](./src/ai/model.ts)) —
the AI SDK's scripted in-memory implementation of the same `LanguageModelV4`
interface a real provider ships. No API key, no network; the instrumented-model
middleware, cost estimator, quota, and usage rollups all run for real against
it. Swapping in Anthropic is one line. [`ai/ai.test.ts`](./src/ai/ai.test.ts)
drives the whole thing — HTTP routes included — with the in-memory store and an
array-backed dispatcher: the entire durable-workflow feature is testable with
no Docker.

## Notes for framework readers

Things that cost time here and are worth knowing before you copy this code:

- **`createLoggerService(...)` returns a facade, not a `Logger`.** Every module
  wants the `Logger` — but keep the facade, don't destructure it away. With
  `otlp` configured, `shutdown()` is the only thing that drains the export
  buffer, so `const { logger } = createLoggerService(…)` silently loses whatever
  hadn't been POSTed at exit. `main.ts` holds `loggerService` and awaits
  `shutdown()` last in `stop`, after the components that log on the way down.
- **`withDbErrorHandling` needs explicit type arguments** when the callback can
  return more than one error type — inference latches onto one branch and
  rejects the rest. See `getById` in `services/contacts.ts`.
- **`Result<T, never>` still needs an `if (!result.ok)` guard.** TS won't narrow
  the union away just because the error type is uninhabited (`createBaseCrudService`'s
  `list` returns one).
- **`createBaseCrudService` stamps `updatedAt` with a `Date`**, so a
  `timestamp(..., { mode: 'string' })` column will fail on update. `notes` uses
  the default date mode.
- **`baseScopeColumns` is not a timestamp mixin.** Its `id`/`name`/`createdAt`
  shape is tempting, but it is the *scope-owner root* column-set (a
  workspace/tenant row). `contacts` and `notes` use plain columns.
- **`createScopedConfigService` must not be a singleton.** Its read cache is
  scoped to one unit of work and is invalidated only by writes through that same
  instance — so a process-wide singleton serves stale config after any *other*
  process writes. It is registered `Transient` here, and the mail service
  resolves it per send rather than capturing one instance.
- **The Postgres blob provider reads content-type out of `metadata`** — pass
  `metadata: { 'content-type': … }`; there is no dedicated parameter.
- **Mount the client-IP middleware before the rate limiter**, or every request
  keys into one shared `'unknown'` bucket. On Hono this is *yours* to get right:
  `createHonoApp` has no `clientIp` option, because the `middleware` array IS
  the pipeline. The limiter logs a one-time warning when `c.get('clientIp')` is
  missing — treat that line in the log as a wiring bug, not a notice.
- **A flow step handler throws to fail; everything else here returns `Result`.**
  The engine owns retry/DLQ policy, so `ai/workflows.ts`'s handlers convert a
  failed `Result` into a throw at the boundary.
- **`defineAiStep` needs explicit generics on dependent steps** — inference
  can't recover `THost` from `dependencies` (the `THost = unknown` default wins),
  so `summarize`/`followup` pass `<Input, Output, AiHost, { fetch: typeof fetch }>`.

### Hono-specific (new with the 2026-08-04 migration)

- **A Hono app is a handler, not a server.** It has no `.listen()`; the runtime
  owns listening. [`bun-server.ts`](./src/bun-server.ts) is the ten-line
  `Bun.serve` adapter that satisfies `…/server`'s structural `ListenableApp`,
  and it stays app-local on purpose — a framework version would have to pick a
  runtime, which is exactly the decision a consumer owns. Set
  `maxRequestBodySize` there explicitly: it was `createElysiaApp`'s option
  before, and Bun's 128 MB default is two orders of magnitude looser.
- **`hono-openapi` silently omits any route without `describeApiRoute`.**
  `@elysiajs/swagger` put every route in the document whether you described it
  or not; this stack documents only what you describe. The visible consequence
  here: `/health/*` and the six `…/hono/flow` workflow routes serve correctly
  but do **not** appear in `/openapi.json`, because those routes are built
  inside framework factories that don't describe themselves. Count the
  operations in `/swagger` against the route table before believing the spec is
  complete.
- **The security-headers middleware always wins, so relax by *choosing*, not
  overriding.** It sets its map on `c.res` *after* `next()`, which is what gets
  the headers onto error responses and 404s — and also means nothing downstream
  can override a header for one route. Serving a Swagger page under
  `default-src 'none'` therefore needs two pre-built instances behind a path
  test at the top of the pipeline (see `createSecurityHeaders` in
  [`app.ts`](./src/app.ts)), which keeps the API hardened byte-for-byte.
- **A CSP violation is invisible to `curl`** — same moral as the CORS section
  above. The docs CSP here was written against `unpkg` and the page stayed
  blank until a browser said `@hono/swagger-ui` actually loads swagger-ui-dist
  from `cdn.jsdelivr.net`.
- **`return c.body(null, 204)`, not `return undefined`.** A Hono handler must
  return a `Response`. (The upside: the old Elysia note about node rejecting an
  empty-string 204 body is simply gone — `DELETE /api/notes/:id` and
  `DELETE /api/contacts/:id` both answer 204 on any runtime now.)
- **Path params and query values arrive as strings, always.** `z.coerce.number()`
  in the validator is what converts them, and the *client* side inherits it:
  `hc` types a query value as `string`, so a page passes
  `{ pageSize: String(n) }`. Declaring `z.number()` without `coerce` typechecks
  and rejects every real request.
- **`createRouteModule` is not ceremony.** Hono types `c.get('scope')` off the
  `Env` you *declare*, and never checks that the middleware supplying it is
  mounted — a module can typecheck perfectly and read `undefined` at runtime.
  The factory only hands out the builder app once you have handed over matching
  middleware, which is the whole point of using it for contacts/settings/protected.
- **Chain, don't sequence.** Hono accumulates route types through the return
  value of the chain, so `new Hono().route(a).route(b)` types both while
  `const app = new Hono(); app.route(a); app.route(b);` serves identically and
  types as *nothing*. The same trap catches helper functions that compose apps
  — see the migration notes in the framework's `hono/create-app.ts`.
- **Multipart is zod now.** `z.file()` plus `octApiValidator('form', …)`
  replaced the `t.Object({ file: t.File() })` that was this repo's only TypeBox
  use. One schema language throughout.
