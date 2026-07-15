# @octabits-io/framework/elysia

Reusable [Elysia](https://elysiajs.com) middleware and helpers, extracted from
production APIs. Domain-agnostic — errors are
[`@octabits-io/framework`](../foundation)'s `OctError` (`{ key, message }`;
`KeyedError` is kept as an alias), the error handler takes foundation's
`Logger`, and any domain-specific key→status rules are injected via
`statusOverrides`. Foundation is a **peer dependency** — this package is part
of the octabits stack, not a standalone kit.

## Contents

- **`createSecurityHeadersPlugin(options?)`** — sets standard hardening response
  headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `X-XSS-Protection: 0`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`,
  `Cross-Origin-Resource-Policy`, CSP, and HSTS in production) on every
  response, **including error responses** (headers are staged in `onRequest`).
  All values configurable/disable-able via options.
- **`createClientIpPlugin(trustedProxies)`** — derives `clientIp` from
  `X-Forwarded-For` only when the direct connection is a trusted proxy (`'*'`,
  an IP allowlist, or `[]` for none), walking the chain **right-to-left** past
  trusted proxy hops (rightmost-untrusted, spoof-resistant); IPv6-mapped IPv4
  is normalized, garbage entries fall back to the direct peer. Used to key
  rate limiting. `createClientIpResolver` / `normalizeIp` expose the pure logic.
- **Error mapping** — `getStatusCodeForError`, `statusErrorWithSet`,
  `mapResultError`, the `ApiError` class family (`NotFoundError`,
  `ForbiddenError`, `ConflictError`, …), `isDbConnectionError`, and the
  `createErrorHandler` global plugin. Response bodies are whitelisted to
  `{ key, message[, fields] }`, and 5xx messages are redacted in production (the
  stable `key` is kept). A thrown `Response` passes through the error handler
  verbatim (the `resolve`-short-circuit escape hatch — see
  `createBearerAuthPlugin`). Key conventions, checked in order:
  `*_not_found` → 404, `unauthorized`/`invalid_token` → 401,
  `forbidden`/`permission_denied` → 403, `invalid_*`/`validation_*` → 400,
  `missing_*`/`incomplete_*`/`*_not_configured` → 422, `already_*`/`*_conflict`
  → 409, `rate_limit_exceeded`/`*_rate_limited` → 429, else 500. Earlier rules
  win, so `invalid_state_conflict` is a 400, not a 409. There is deliberately
  **no 423 convention** (no key shape reliably means "locked") — use an explicit
  `ApiError(423, …)` or a `statusOverrides` entry.
- **`createErrorMapper(overrides)`** — binds domain `statusOverrides` once and
  returns `{ getStatusCodeForError, statusErrorWithSet, mapResultError }`
  pre-applied. Re-export the trio after an `export *` from this package to
  shadow the unbound originals, so route code calls
  `statusErrorWithSet(set, err)` and cannot forget the domain rules.
- **`createRateLimit(options)`** — app-level rate limiting with a
  timing-safe skip-by-internal-secret seam and a skip-by-CIDR seam
  (`skipCidrs`: real IPv4 CIDR matching, e.g. `10.0.0.0/24`, or exact IPs;
  IPv6-mapped keys normalized). `errorKey`/`errorMessage` set the 429 JSON body
  (default key: `rate_limit_exceeded` — the same key the 429 convention maps).
- **`createBearerAuthPlugin({ authService, … })`** — the `resolve`-and-throw
  bearer middleware, over a **structural** `validateAuthorizationHeader(header)`
  seam (satisfied by `…/auth`'s `createBearerAuthService` /
  `createJwtValidationService` — no dependency on the auth module). Exposes the
  validated token as `ctx.validatedToken` (rename via `contextKey`; the token
  type flows through). Failure keys map to statuses override-first: built-in
  `jwks_unavailable → 503 service_unavailable` (message kept, key normalized),
  every other key → 401 with its key/message preserved; extend via
  `statusOverrides`. `authorize(token, ctx)` returning `false` → 403 (throw from
  it for a custom key/message). `onUnauthorized(failure, ctx)` **throws its
  return value** in place of the default `ApiError` — an Elysia `resolve` hook
  cannot short-circuit by *returning* (the value is merged into the context and
  the handler still runs), so the seam is throw-based; return a `Response` to
  short-circuit verbatim (the JSON-RPC-envelope case), or a custom `Error` for
  your own `onError` to format.
- **`buildSwaggerOptions({ title, version, description?, tags?, path?, exclude? })`**
  — flattens the repeated `@elysiajs/swagger` options literal. Returns a plain
  structurally-typed object; **no dependency on `@elysiajs/swagger`** (the caller
  builds the plugin: `swagger(buildSwaggerOptions({ … }))`). `path` defaults to
  `/swagger`; unset optionals are omitted rather than emitted as `undefined`.
- **`runElysiaServer({ load, logger?, exitProcess?, shutdown? })`** — the
  `main()` tail: `await load()` → `app.listen(port)` → started-log → 
  `registerGracefulShutdown`. Everything that can fail during bootstrap lives in
  the caller's `load()`, so a throw there is uniformly logged as
  `'Failed to start server'` + `process.exit(1)` instead of becoming an
  unhandled rejection. `load()` returns `{ app, port, logger?, stop?, onStarted? }`
  — `logger` is returned (not passed) because the app logger usually only exists
  once the container is up; it falls back to the bootstrap `logger`. Runtime-
  agnostic (the app only needs `.listen(port)`, so Elysia is never imported) and
  **importing the module boots nothing**. `exitProcess: false` rethrows instead
  of exiting, for tests and embedders.
- **`createElysiaApp(routes, options)`** — the standard app skeleton
  (`securityHeaders → clientIp → rateLimit → [cors/swagger] → errorHandler → routes`),
  preserving the routes' type for Eden Treaty; plus **`registerGracefulShutdown`**.
- **`createHealthRoutes({ checkReady })`** — `/health` + `/live` + `/ready` with the
  readiness-failure → 503 mapping.
- **`createRequestScopePlugin({ createScope, contextKey?, guard?, logger? })`** — a
  per-request IoC scope as `ctx.scope`, with disposal guaranteed on every exit path:
  success → `onAfterResponse` disposes `{ commit: true }`; handler error →
  `onError` disposes `{ commit: false }`; `guard` rejection → disposed inline
  `{ commit: false }` before any handler runs. `createScope(ctx)` allocates +
  seeds (e.g. `container.createScope()` plus scoped registrations from the
  request); `guard(scope, ctx)` holds checks that need the scope — the plugin
  owns dispose-on-throw so a failing check can't leak it. The scope is only
  required to satisfy the structural `RequestScope` contract (`dispose(opts?)`,
  idempotent — the `…/ioc` container's is), so augmented containers type
  through unchanged. Both hooks are `{ as: 'scoped' }`; mount the plugin (it
  deduplicates by `name`) in each route module that reads `ctx.scope` so the
  typing flows. Dispose failures after a sent response are logged via `logger`,
  never thrown. `contextKey` renames the context property (migrating consumers
  keep their established name, e.g. `'container'`), and `createScope` may return
  `{ scope, extras }` to merge extra values into the handler context alongside
  the scope (e.g. an id parsed while seeding — plain values, no lifecycle).
- **`@octabits-io/framework/elysia/mcp`** — `createMcpRoutes({ resolveScope, registerTools, … })`:
  stateless `elysia-mcp` harness with a per-request scope correlated via
  `AsyncLocalStorage` (interleaving-safe under concurrent requests) and disposed
  in a `finally` tied to the request. `registerTools` also runs once at startup —
  it must be idempotent and must only call `getContainer()` inside tool handlers,
  at invocation time. Scope-key extraction via the required `parseScopeKey` seam —
  no default URL convention.
  Use `createPathSegmentScopeParser('scope')` for a `/scope/:scopeKey/` layout,
  `createPathSegmentScopeParser('tenant')` for `/tenant/:id/`, or `() => 'default'`
  for single-scope deployments (it matches the segment's last occurrence and caps
  key length at 256).
  The returned plugin composes under prefixed parents (`.use()` it anywhere in a
  nested route tree); matched requests are internally re-addressed, so
  `resolveScope` should read the public URL from its `url` argument, not from
  `context.request.url`.
  `elysia-mcp` + `@modelcontextprotocol/sdk` are optional peers.
  ⚠️ On **Node runtimes** (e.g. vitest), `elysia-mcp` ≤0.1.1 calls
  `Bun.randomUUIDv7()` on every stateless request — shim it in test setup
  *after* importing `elysia` (so Elysia's runtime detection is unaffected):
  `globalThis.Bun = { randomUUIDv7: () => crypto.randomUUID() }`.
- **`@octabits-io/framework/elysia/flow`** — `createFlowWorkflowRoutes({ engine, … })`:
  the generic read/control routes over an `@octabits-io/flow` engine — list
  (newest first, `entityRef`/`status`/`type`/`limit`), active-probe, get,
  status snapshot, cancel (200 with a body — a 204 with Elysia's empty-string
  body trips node's `Response` constructor), and resume (event delivery to a
  `waiting` step). The wire shape is flow's public view (`toPublicWorkflow` +
  `PUBLIC_WORKFLOW_SCHEMA` — engine internals like `partitionKey`,
  `idempotencyKey`, `metadata`, `attempts` never leak; engine step statuses
  fold to the five display states), served with declared `response` schemas
  (Eden narrowing + OpenAPI) and `createErrorMapper`-based error mapping
  (`errorOverrides` for domain keys, e.g. `{ ai_quota_exceeded: 429 }`).
  Consumer wire fields ride the `extendWorkflow: { schema, load?, project }`
  seam — schema fragment and projection travel together so declared type and
  served value cannot drift, and the optional `load(workflows, ctx)` batches
  side-table reads once per request before `project(workflow, loaded)` runs
  per row. `engine` is the structural `FlowEngineReader` (a partition-bound
  `WorkflowEngine` satisfies it) **or a per-request resolver** `(ctx) =>
  engine` for hosts whose engine lives in a request scope; `authorize(action,
  ctx)` gates each route (return a keyed error — `forbidden` → 403). Map/
  sub-workflow child steps are excluded from the wire by default
  (`includeChildSteps: true` opts in). **Start/trigger routes stay in the app**
  (domain body shape, `entityRef` convention, quota/auth policy).
  `@octabits-io/flow` is an optional peer, pulled in only by this `./flow`
  subpath.
- **Env-config helpers** — `getEnv*`, `isProduction`, `parseCsv`,
  `parseCorsOrigins`, and **`assertNotInProduction(name, value?)`** — fails
  startup when a dev-only escape hatch (auth bypass, seed endpoint, debug route)
  is set in production. Omit `value` to read `process.env[name]`. Any non-empty
  string counts as set (including `'false'` — these are presence-flags).
- **Response schemas** — `SCHEMA_ERROR_RESPONSE`, `SCHEMA_VALIDATION_ERROR`,
  `SCHEMA_SUCCESS_RESPONSE`, the `CommonErrorResponses` superset, and the
  `errorResponses(...codes)` selector.
- **`successResponses(status, schema)`** — `{ [status]: schema, 200: schema }`.
  An Eden Treaty workaround, not an HTTP nicety: Eden derives `data` as
  `Extract<Response, SuccessCodes>`, and Elysia infers a 200 entry from the
  handler's return union — so on a route whose only *declared* success code is
  non-200 (e.g. `201`), that inferred 200 carries the whole union, error bodies
  included, and Eden folds them into `data`. Declaring 200 explicitly pins the
  entry so the union splits correctly:
  `response: { ...successResponses(201, Created), ...errorResponses(400, 409) }`.
- **`@octabits-io/framework/elysia/testing`** — `testRequest(app, method, path, { body?, headers?, query?, token?, decodeBody? })`
  and `testAuthenticatedRequest(app, method, path, options, authHeader)`: drive
  an app through `app.handle()` — no port binding — returning
  `{ status, data, headers }`. Default decoding: `204`/`301`/`302` → `null`,
  JSON → parsed, `application/pdf`/`application/octet-stream` → `Buffer`
  (byte-exact), else `text()`; override via `decodeBody` (which can delegate to
  the exported `decodeResponseBody`). Headers merge case-insensitively over the
  default `content-type: application/json`. A separate subpath, deliberately not
  re-exported from the root (test helpers should not be reachable from
  production route code), and test-runner agnostic — no vitest import.

## Usage

```ts
import { Elysia } from 'elysia';
import {
  createSecurityHeadersPlugin,
  createClientIpPlugin,
  createErrorHandler,
  statusErrorWithSet,
  CommonErrorResponses,
} from '@octabits-io/framework/elysia';

const app = new Elysia()
  .use(createSecurityHeadersPlugin())
  .use(createClientIpPlugin(['*']))
  .use(createErrorHandler(logger));

// In a route, translate a Result error to an HTTP response:
if (!result.ok) return statusErrorWithSet(set, result.error, { tenant_not_found: 403 });
```

Peer dependencies: `@octabits-io/framework`, `elysia`, `zod` (plus the
optional `elysia-mcp` + `@modelcontextprotocol/sdk` peers, pulled in only by
the `./mcp` subpath).
