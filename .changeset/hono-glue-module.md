---
"@octabits-io/framework": minor
---

New `./hono` glue module — the successor of `./elysia`.

- **`./hono`**: `createRequestScopeMiddleware` (the disposal triangle as one wrapping middleware), `createBearerAuthMiddleware` (Response short-circuit), `registerErrorHandler` + `octValidator` (shared `resolveErrorResponse` core; raw thrown `Response` becomes `HTTPException(status, { res })`), `createSecurityHeadersMiddleware`, `createClientIpMiddleware` (lazy Bun conninfo, off-Bun safe), `createRateLimitMiddleware` (vendor-free fixed-window on in-house cores), `createHealthApp`, `createHonoApp`, `createRouteModule` (closes the declared-`Env` hole by construction), `testableHonoApp`.
- **`./hono/flow`**: `createFlowWorkflowRoutes` without the prefix generic or the Elysia type workarounds — mount via `app.route(prefix, …)`.
- **`./hono/mcp`**: the MCP harness on official `@hono/mcp` (per-request `McpServer` + `StreamableHTTPTransport`; replaces the nested-app workaround). Same `parseScopeKey`/`DisposableScope` seams.
- **`./hono/openapi`**: `describeApiRoute` (takes the existing `successResponses`/`errorResponses` zod maps), `octApiValidator` (validation + spec + standard `validation_error` body), `mountOpenApi` over `buildSwaggerOptions` — on `hono-openapi` (middleware-style, `hc`-safe), vendor-confined to one file with a composition gate test.
- **`./hono/events`**: `createEventStreamApp` sub-app wrapper over the SSE handler.

The framework-neutral cores moved to the base tier (`./server`): error mapping/`ApiError` family/`resolveErrorResponse`, request-scope + bearer-auth structural contracts, `buildSecurityHeaders`, the client-IP trust-walk resolver, and the rate-limit cores incl. a new `createFixedWindowLimiter`. Everything remains re-exported from `./elysia` — no breaking changes; `./elysia` is now maintenance-only (see `docs/elysia.md`).

`hono`, `@hono/zod-validator`, `@hono/mcp`, and the `hono-openapi` stack are optional peer dependencies — installing them activates the `./hono/*` subpaths. The boundary lint now enforces the same per-file vendor confinement for `src/hono` as for `src/elysia`.

**`hc` client-type preservation (found by migrating `apps/demo-*` onto the module).** Four separate places silently dropped or broke the route types a typed client is built from — every one of them invisible at runtime, since the app keeps serving either way:

- `createHonoApp`, `createHealthApp`, `mountOpenApi`, `registerErrorHandler` and `createEventStreamApp` annotated their returns as `Hono` (= `BlankSchema`), erasing every route from `hc<typeof app>`. They now carry the app type through — as ONE type parameter (`T extends Hono<any, any, any>`), because decomposing into `<E, S, P>` loses nested `.route(...)` schemas just as thoroughly.
- `mountOpenApi` additionally must not return its own `app.get(specPath, …)` type: `specPath` is a `string`, and Hono collapses a schema keyed by a non-literal path into an index signature, taking every sibling route with it.
- `./hono/flow` typed its served workflow view as `z.output<typeof buildFlowWorkflowSchema(ext?.schema)>`, which carries an unevaluated `$InferObjectOutput<…>` conditional into every route's output. TypeScript 7 absorbs it; **TypeScript 6 overflows its call stack** on `hc<App>` — a hard failure for consumers pinned below 7 (e.g. anything on `vue-tsc`). It is now the equivalent intersection, and the emitted `flow.d.ts` shrank 62%.

`create-app.test.ts` and `flow.test.ts` pin all of it.
