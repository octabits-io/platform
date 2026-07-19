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

## Run it

```bash
# 1. Postgres on :5433 (user/password/db all "demo")
docker compose -f apps/demo-server/docker-compose.yml up -d --wait

# 2. From the repo root
pnpm install
pnpm --filter @octabits-io/demo-server dev     # bun --watch
# or: pnpm --filter @octabits-io/demo-server start
```

Then `curl http://localhost:3001/health/ready` → `{"status":"ok","db":"connected"}`.

Zero configuration is required — every value in [`.env.example`](./.env.example)
has a working default, including committed **dev** PII keys. The app refuses to
boot with those keys when `NODE_ENV=production`.

Tables are created at startup with idempotent `CREATE TABLE IF NOT EXISTS` DDL
(see [`src/db/ddl.ts`](./src/db/ddl.ts)). A real service would own migrations via
`@octabits-io/framework/drizzle/migrate` instead.

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
| DELETE | `/api/contacts/:id` | **RBAC-guarded** — `x-demo-role: admin` required |
| POST | `/api/contacts/:id/welcome` | Enqueue a welcome email, idempotent per contact |
| GET | `/api/notes` | List (`createBaseCrudService`) |
| POST | `/api/notes` | Create |
| GET | `/api/notes/:id` | Read one — missing → `note_not_found` → 404 |
| PUT | `/api/notes/:id` | Update |
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
| GET | `/api/protected/whoami` | **Bearer API-key auth** (`createBearerAuthPlugin` + `…/auth`) — the boot log prints a `demo_…` key once |
| GET | `/swagger` | OpenAPI UI (`buildSwaggerOptions` + caller-built `@elysiajs/swagger`; `ENABLE_SWAGGER=false` to disable) |

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
this API — so it needs CORS. `cors()` mounts through `createElysiaApp`'s
`plugins` seam (the framework takes plugins as ready-built instances so it need
not depend on `@elysiajs/*`), with `x-demo-role` in `allowedHeaders` and
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
| `./logger` | [`main.ts`](./src/main.ts) — root logger, childed per component | ✅ |
| `./utils` | [`routes/tools.ts`](./src/routes/tools.ts) (`slugify`), `createDateProvider` in the container | ✅ |
| `./config-schema` | [`config.ts`](./src/config.ts) — `DATABASE_CONFIG_SCHEMA`, `LOGGING_CONFIG_SCHEMA`, `MAIL_CONFIG_SCHEMA`, `createConfigParser`, `nonEmptyString/Url` | ✅ |
| `./rbac` | [`rbac.ts`](./src/rbac.ts) — statement matrix + `admin`/`viewer` roles | ✅ |
| `./pii` | [`services/contacts.ts`](./src/services/contacts.ts) — age encryption + HMAC blind index | ✅ |
| `./captcha` | [`routes/tools.ts`](./src/routes/tools.ts) — no-op provider behind the real contract | ✅ |
| `./auth` | [`api-keys.ts`](./src/api-keys.ts) — `createApiKeyFormat` + `createBearerAuthService` behind `/api/protected` (the IdP-free half; JWT validation still needs an IdP) | ✅ |
| `./drizzle/factory` | [`main.ts`](./src/main.ts) — `createDrizzle(schema, { pool })` | ✅ |
| `./drizzle/db` | `withDbErrorHandling`, `normalizePaginationLimit` in the contacts service | ✅ |
| `./drizzle/scope` | [`db/schema.ts`](./src/db/schema.ts) — `scopedConfigColumns`, `bytea` | ✅ |
| `./drizzle/crud` | [`services/notes.ts`](./src/services/notes.ts) — `createBaseCrudService` drives the whole entity | ✅ |
| `./drizzle/config` | [`services/settings.ts`](./src/services/settings.ts) — unscoped `createScopedConfigService` | ✅ |
| `./drizzle/idempotency` | `POST /api/contacts/:id/welcome` — `begin()` / `commit()` | ✅ |
| `./elysia` | [`app.ts`](./src/app.ts) — `createElysiaApp`, `createHealthRoutes`, `registerGracefulShutdown`, `statusErrorWithSet`, `errorResponses`, env helpers; [`request-scope.ts`](./src/request-scope.ts) — `createRequestScopePlugin`: contacts + settings resolve via `ctx.scope` (request-seeded `role`, per-request `settingsService` cache), the `guard` rejects unknown roles with `invalid_demo_role` → 400; `successResponses` on every non-200-success route (the Eden narrowing fix); `runElysiaServer` owns [`main.ts`](./src/main.ts)'s tail; `createBearerAuthPlugin` guards `/api/protected`; `buildSwaggerOptions` + `assertNotInProduction` in [`config.ts`](./src/config.ts); [`app.test.ts`](./src/app.test.ts) runs on `…/elysia/testing`'s `testRequest` | ✅ |
| `./elysia/flow` | [`routes/ai.ts`](./src/routes/ai.ts) — `createFlowWorkflowRoutes` serves the generic workflow read/control routes (list/active/get/snapshot/cancel/resume) over flow's public wire view; `appliedAt` rides the `extendWorkflow` seam, `ai_quota_exceeded → 429` via `errorOverrides`. Only the domain trigger route and `/usage` are hand-written. | ✅ |
| `./queue` | [`queues/welcome-email.ts`](./src/queues/welcome-email.ts) — `defineQueue` + `BossManager`; dead letters persist to `job_audit_log` via `…/drizzle/job-audit-store` | ✅ |
| `./storage` + `./storage/postgres` | [`routes/files.ts`](./src/routes/files.ts) — provider + `createWebResponse` + `objectStorageDdl` | ✅ |
| `./mail` | [`services/mail.ts`](./src/services/mail.ts) — `createBaseMailService` + logger transport | ✅ |

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
| `./elysia/mcp` | Skipped — see below. |
| `./ioc`'s `withScope`/`forEachScope` | The queue module already owns the worker's scope lifecycle here; a fan-out sweep over one scope would be filler. |
| `./drizzle/rls`'s `createGucScopeFactory` | The ioc↔rls bridge needs RLS policies + a partitioned schema; this app is single-scope by design (same reason as `./drizzle/rls` above). |
| `./elysia`'s `createErrorMapper` | ~~No domain key→status overrides~~ — now covered: [`routes/ai.ts`](./src/routes/ai.ts) pre-binds `ai_quota_exceeded → 429`. |
| `./signing`'s `constantTimeEquals` | No inbound webhook to verify. |
| `./drizzle/crud`'s `createScopedCrudService` | The scoped sibling of the factory used here. Needs a scope column; this app is single-scope. |

`./elysia/mcp` was left out deliberately: it needs two more optional peers
(`elysia-mcp`, `@modelcontextprotocol/sdk`) and its value is an MCP client
session, which no curl in this README can verify. Mounting it untested would be
worse documentation than omitting it.

## `@octabits-io/flow` coverage

The durable AI workflow behind `/api/ai/*` consumes the **published**
`@octabits-io/flow` from npm (not a workspace link — this app also validates
its packaging). One workflow ships: `contact-brief`, a three-step DAG
(`fetch` → `summarize` ∥ `followup`) whose two AI steps run in parallel because
the engine derives that from their dependencies.

| Export | Used in | Covered |
| --- | --- | --- |
| `.` (core) — `createWorkflowEngine`, `defineStep` types via `defineAiStep`, registry, `createInMemoryWorkflowStore`; the public wire view (`toPublicWorkflow`, `PUBLIC_WORKFLOW_SCHEMA`) is consumed indirectly through `…/elysia/flow`'s route factory | [`ai/engine.ts`](./src/ai/engine.ts), [`ai/testing.ts`](./src/ai/testing.ts), [`routes/ai.ts`](./src/routes/ai.ts) | ✅ |
| `./ai` — `defineAiStep`, `buildAiWorkflow`, `createAiWorkflowHooks`, `createCostEstimator`, `createAiQuotaService`, `createAiUsageAggregationService` | [`ai/workflows.ts`](./src/ai/workflows.ts), [`ai/engine.ts`](./src/ai/engine.ts), [`ai/runtime.ts`](./src/ai/runtime.ts); the consumer-SQL `AiUsageStore`/`AiUsageRecorder` seams live in [`ai/usage.ts`](./src/ai/usage.ts) over the `ai_*` tables | ✅ |
| `./store-pg` — `createPgWorkflowStore`, `flowStoreDdl` | [`ai/runtime.ts`](./src/ai/runtime.ts); DDL applied in [`db/ddl.ts`](./src/db/ddl.ts) next to `objectStorageDdl()` | ✅ |
| `./dispatcher-pgboss` — dispatcher + step/DLQ workers | [`ai/runtime.ts`](./src/ai/runtime.ts) — on the **same** pg-boss instance `BossManager` owns (`boss.getBoss()`) | ✅ |
| Not covered | `createPgStepGate`/`flowGateDdl` (global concurrency/rate gates), `createPgEventSink`/`flowEventDdl` (run-history timeline), `defineWaitStep`/`defineMapStep`/`defineSubWorkflowStep`/saga compensation, `createPgBossScheduler` (cron starts), `recoverStuckWorkflows` sweeps — the flow repo's `examples/` cover these | — |

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
  wants the `Logger`; destructure it: `const { logger } = createLoggerService(…)`.
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
- **Mount the client-IP plugin before the rate limiter**, or every request keys
  into one shared `'unknown'` bucket. `createElysiaApp`'s `clientIp` option
  guarantees the order — that is the reason to use it.
- **Avoid `204` + `return undefined` in routes that must also run under node.**
  Elysia hands node's `Response` constructor an empty-string body, which it
  rejects for 204 (bun does not) — so a vitest-driven `app.handle` 500s where
  `bun dev` works. The AI cancel route returns `200 {cancelled}` for this
  reason; `DELETE /api/notes/:id` keeps the 204 because only bun serves it.
- **A flow step handler throws to fail; everything else here returns `Result`.**
  The engine owns retry/DLQ policy, so `ai/workflows.ts`'s handlers convert a
  failed `Result` into a throw at the boundary.
- **`defineAiStep` needs explicit generics on dependent steps** — inference
  can't recover `THost` from `dependencies` (the `THost = unknown` default wins),
  so `summarize`/`followup` pass `<Input, Output, AiHost, { fetch: typeof fetch }>`.
