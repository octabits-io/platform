# @octabits-io/elysia

Reusable [Elysia](https://elysiajs.com) middleware and helpers, extracted from
production APIs. Domain-agnostic — errors are
[`@octabits-io/foundation`](../foundation)'s `OctError` (`{ key, message }`;
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
  `ForbiddenError`, …), `isDbConnectionError`, and the `createErrorHandler`
  global plugin. Response bodies are whitelisted to `{ key, message[, fields] }`,
  and 5xx messages are redacted in production (the stable `key` is kept).
- **`createRateLimit(options)`** — app-level rate limiting with a
  timing-safe skip-by-internal-secret seam and a skip-by-CIDR seam
  (`skipCidrs`: real IPv4 CIDR matching, e.g. `10.0.0.0/24`, or exact IPs;
  IPv6-mapped keys normalized).
- **`createElysiaApp(routes, options)`** — the standard app skeleton
  (`securityHeaders → clientIp → rateLimit → [cors/swagger] → errorHandler → routes`),
  preserving the routes' type for Eden Treaty; plus **`registerGracefulShutdown`**.
- **`createHealthRoutes({ checkReady })`** — `/health` + `/live` + `/ready` with the
  readiness-failure → 503 mapping.
- **`@octabits-io/elysia/mcp`** — `createMcpRoutes({ resolveScope, registerTools, … })`:
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
- **Env-config helpers** — `getEnv*`, `isProduction`, `parseCsv`, `parseCorsOrigins`.
- **Response schemas** — `SCHEMA_ERROR_RESPONSE`, `SCHEMA_VALIDATION_ERROR`,
  `SCHEMA_SUCCESS_RESPONSE`, the `CommonErrorResponses` superset, and the
  `errorResponses(...codes)` selector.

## Usage

```ts
import { Elysia } from 'elysia';
import {
  createSecurityHeadersPlugin,
  createClientIpPlugin,
  createErrorHandler,
  statusErrorWithSet,
  CommonErrorResponses,
} from '@octabits-io/elysia';

const app = new Elysia()
  .use(createSecurityHeadersPlugin())
  .use(createClientIpPlugin(['*']))
  .use(createErrorHandler(logger));

// In a route, translate a Result error to an HTTP response:
if (!result.ok) return statusErrorWithSet(set, result.error, { tenant_not_found: 403 });
```

Peer dependencies: `@octabits-io/foundation`, `elysia`, `zod` (plus the
optional `elysia-mcp` + `@modelcontextprotocol/sdk` peers, pulled in only by
the `./mcp` subpath).
