# @octabits-io/framework/hono

Reusable [Hono](https://hono.dev) middleware and helpers — the package's
second HTTP glue module and the successor of
[`./elysia`](./elysia.md). Same design rules:
domain-agnostic, errors are `OctError` (`{ key, message }`), domain key→status
rules injected via `statusOverrides`, and **all real logic lives in the
framework-neutral cores under [`./server`](./server.md)** — this module is
thin, replaceable wiring. `hono` and `@hono/zod-validator` are optional peer
dependencies; installing them is what activates this subpath.

Streaming and other special transports stay **fetch-first**: write a plain
`(request: Request) => Promise<Response>` handler and `app.mount(path, handler)`
it (Hono's first-class API for exactly this) instead of bending the context
around it. Shipped examples: `../events`' `createEventStreamHandler` (SSE; a
sub-app wrapper lives at `./hono/events`) and `../storage`'s postgres serve
handlers.

## Contents

- **`createSecurityHeadersMiddleware(options?)`** — the standard hardening
  headers on every response including error responses and 404s (set on `c.res`
  after `next()`, by which point `onError` has already produced the final
  response). Same header set and options as the Elysia plugin; the pure core
  is `./server`'s `buildSecurityHeaders`. Mount first (outermost).
- **`createClientIpMiddleware({ trustedProxies, getDirectIp? })`** — derives
  `c.get('clientIp')` via `./server`'s trust-walk resolver (rightmost-untrusted,
  CIDR-aware). The direct connection IP defaults to Bun conninfo (`hono/bun`,
  loaded lazily — off-Bun it degrades to `'unknown'`); inject `getDirectIp` on
  other runtimes. `ClientIpEnv` is the `Env` contribution.
- **`createRateLimitMiddleware(options)`** — fixed-window limiter built
  entirely from `./server/rate-limit`'s cores (**no vendor dependency**, unlike
  the Elysia wrapper around `elysia-rate-limit`). Same configuration surface:
  keyed on `clientIp` (or a custom key function), `skipCidrs`, timing-safe
  `internalSecret` header bypass, `skipPaths` for self-limiting mounted
  endpoints, `{ key, message }` 429 body + `Retry-After`. No `scoping` option:
  where you mount it IS the scope.
- **Error handling** — `registerErrorHandler(app, logger, options?)` wires the
  shared `resolveErrorResponse` classifier (same key conventions, production
  redaction, DB-connection → 503) into `app.onError`. Two Hono-specific rules:
  - **Validation**: use `octValidator(target, schema)` (a `zValidator` wrapper)
    — it throws a `RequestValidationError` whose shape the shared classifier
    maps to the standard `{ key: 'validation_error', message, fields }` body,
    instead of zod-validator's raw 400.
  - **No raw thrown `Response`**: Hono rethrows non-`Error` values past
    `onError`. The escape hatch for "answer with this exact response from deep
    inside" is `HTTPException(status, { res })`, which passes through verbatim.
- **`createBearerAuthMiddleware(options)`** — same seams as the Elysia plugin
  (structural `BearerTokenValidator`, `authorize` → 403, `jwks_unavailable` →
  503-as-`service_unavailable`, `statusOverrides`), but the rejection seam
  simplifies: an `onUnauthorized` returning a `Response` is **returned**
  (Hono's native short-circuit), not thrown. `BearerAuthEnv<TToken>` is the
  `Env` contribution.
- **`createRequestScopeMiddleware(options)`** — the per-request IoC scope as
  ONE wrapping middleware (replaces Elysia's `resolve`/`onAfterResponse`/
  `onError` triangle): create + optional `guard` → `c.set('scope', …)` →
  `await next()` → dispose `{ commit: c.error === undefined }`, with a
  `finally` for the thrown-non-`Error` escape path. Exactly one dispose site;
  no idempotency requirement on the scope. Note the disposal-timing shift vs
  Elysia: disposal happens **before** the `Response` is returned, which is
  irrelevant for JSON bodies and exactly why streams must stay fetch-first
  outside this middleware.
- **`createHealthApp({ checkReady, … })`** — the `/`, `/live`, `/ready` trio;
  mount via `app.route('/health', …)`. `/ready` failures map to 503 in a plain
  try/catch (no `onError` ordering ritual).
- **`createHonoApp(routes, opts)`** — the app skeleton: security headers →
  caller middleware (client-ip, rate-limit, cors, …) → error handler → routes.
- **`createRouteModule({ middleware, path? }, build)`** — **the route-module
  convention.** Hono types `c.get(…)` from a DECLARED `Env`; the compiler
  never proves the supplying middleware is mounted. This factory closes the
  hole by construction: the typed builder app is only reachable by handing
  over `Env`-matching middleware first. Pass a param-carrying `path`
  (`'/tenant/:tenantId/*'`) when the middleware reads route params — bare
  middleware sees `{}`. `build` must chain and return the chain (`hc` route
  types accumulate through the chain).
- **The `hc` type rule** — every factory here that returns an app returns the
  app type it was handed, as ONE type parameter. That is load-bearing and easy
  to undo: `hc` builds its client by walking the app's accumulated `Schema`, so
  annotating a return `Hono` (= `BlankSchema`) erases every route from the
  client type, and even `<E, S, P>` decomposition loses the schema of any app
  built with `.route(...)`. Both failures are silent — the app serves fine and
  only the consumer's `hc<App>` comes up empty. `create-app.test.ts` pins it;
  keep the same shape when adding a factory.
- **`testableHonoApp(app)`** — bridges a Hono app into `./server/testing`'s
  structural `TestableApp`, so `testRequest`/`testAuthenticatedRequest` drive
  both glue modules with the same tests.

## Subpaths

Kept out of the root barrel so their optional peers never load with it:

- **`./hono/flow`** — `createFlowWorkflowRoutes` over an `@octabits-io/flow`
  engine (list/active/get/snapshot/cancel/resume). No prefix option: mount the
  returned sub-app via `app.route(prefix, …)`.
- **`./hono/mcp`** — the MCP harness on the official `@hono/mcp`
  `StreamableHTTPTransport` (per-request `McpServer`, `parseScopeKey` seam,
  `DisposableScope` lifecycle). Replaces the Elysia module's nested-app
  workaround wholesale.
- **`./hono/events`** — `createEventStreamApp(deps)`, the sub-app wrapper over
  `createEventStreamHandler` for consumers that prefer `app.route()` over
  `app.mount()`.
- **`./hono/openapi`** — the OpenAPI layer on `hono-openapi` (chosen over
  `@hono/zod-openapi`: middleware-style, chained routes stay chained, `hc`
  untouched, vendor confined to one file). `describeApiRoute({ summary,
  description, tags, responses })` takes the existing
  `successResponses`/`errorResponses` zod status-maps verbatim;
  `octApiValidator` = validation + `c.req.valid()` typing + spec request
  params + the standard `validation_error` body; `mountOpenApi(app,
  buildSwaggerOptions(…))` serves the 3.1 spec (UI stays the consumer's
  choice) and returns the app unchanged — the spec route stays out of the
  client type on purpose, since its `string` path would otherwise collapse the
  schema. **Undescribed routes are silently omitted from the document**
  (unlike `@elysiajs/swagger`, which listed every route): a route without
  `describeApiRoute` serves but does not appear, which currently includes
  `createHealthApp`'s probes and `./hono/flow`'s six workflow routes. House rule: **no `.transform()` in public route schemas** (zod v4's
  JSON-schema conversion degrades it to `{}`). `openapi.test.ts` is the
  permanent gate against upstream #216 (empty `paths` on composed apps) and
  the silent-omission mode — if an upgrade trips it, the fallback is replacing
  this one file with a hand-rolled route→spec registry over the same seams.

## Migrating a route file from `./elysia`

The mechanical mapping:

| Elysia | Hono |
|---|---|
| `new Elysia({ prefix, tags })` | sub-app + `app.route(prefix, …)` (tags per route via `describeApiRoute`) |
| `.get('/', h, { body, query, params })` | `.get('/', octApiValidator('json'/'query'/'param', schema), h)` (`octValidator` where no spec is served) |
| `ctx.scope` / `ctx.validatedToken` | `c.get('scope')` / `c.get('validatedToken')` with the matching `Env` |
| `set.status = n; return body` | `return c.json(body, n)` |
| thrown `Response` | `throw new HTTPException(status, { res })` |
| `.mount(path, handler)` | `app.mount(path, handler)` (unchanged) |
| `response` status-map option | not validated at runtime; pass the same map to `describeApiRoute({ responses })` |

## Confinement contract

`scripts/check-boundaries.mjs` enforces the same rules as for `./elysia`:
`hono`-tier vendors (`hono`, `@hono/zod-validator`, `@hono/mcp`) are confined
to `src/hono`; `@hono/mcp` only in `mcp.ts`; the shared `@modelcontextprotocol`
SDK and `@octabits-io/flow` only in each glue module's `mcp.ts`/`flow.ts`; and
every non-test file in `src/hono` must import a hono-tier vendor — one that
doesn't is framework-agnostic and belongs in `src/server`. The two glue
modules may never import each other.
