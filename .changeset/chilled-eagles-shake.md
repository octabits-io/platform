---
'@octabits-io/framework': minor
---

**Breaking:** remove the Elysia glue module. The `./elysia`, `./elysia/mcp`, `./elysia/flow`, `./elysia/events` and `./elysia/testing` subpaths are gone, along with the `elysia`, `elysia-mcp`, `elysia-rate-limit` and `@sinclair/typebox` dependencies — `@noble/*`/`@scure/base` are now the package's only hard deps. `./hono` reached parity and is the sole HTTP glue module.

Migrating: `createElysiaApp` → `createHonoApp`, `createRequestScopePlugin` → `createRequestScopeMiddleware`, `createBearerAuthPlugin` → `createBearerAuthMiddleware`, `createErrorHandler` → `registerErrorHandler`, `body`/`query`/`params` route options → `octValidator`/`octApiValidator`, and `./elysia/{mcp,flow,events}` → `./hono/{mcp,flow,events}`. `./elysia/testing` was already just a re-export of `./server/testing`. Full table in the package README.

The boundary lint now rejects Elysia's vendors package-wide, so the glue cannot creep back in.

The framework-neutral cores in `./server` are unchanged — that is what made the swap shallow. Their unit tests, which had only ever lived in the Elysia suite, moved to `src/server/*.test.ts` alongside the code they cover: error mapping (`getStatusCodeForError`, `statusErrorWithSet`, `mapResultError`, `createErrorMapper`, `isDbConnectionError`, `resolveErrorResponse`), the response-schema helpers, `buildSecurityHeaders`, the client-IP trust walk (`normalizeIp`, `createClientIpResolver`, incl. CIDR trusted proxies), `createCidrMatcher`, and the env-config helpers.
