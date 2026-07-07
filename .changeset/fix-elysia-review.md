---
'@octabits-io/elysia': minor
---

Security & correctness fixes from review:

- **mcp (HIGH)**: fixed a cross-request scope-container race — the `pendingContainer`/`activeContainer` closure singletons let concurrent requests see (and dispose) each other's scope. The harness now correlates the resolved scope to its request via `AsyncLocalStorage`: the outer route enters a request-private ALS context, `authentication` stages the scope into it, `getContainer()` reads it at tool-invocation time, and disposal runs in a `finally` tied to the request (exactly once, own container only).
- **mcp**: `getContainer()` is now lazy and safe under elysia-mcp's eager mount-time `setupServer` call — `registerTools` runs once at startup (documented; must be idempotent) and a registration-time `getContainer()` call throws a clear error instead of silently poisoning every request.
- **mcp**: `createPathSegmentScopeParser` now matches the segment's **last** occurrence in the path (an earlier client-controlled component can no longer shift extraction) and caps the extracted key at 256 chars (`MAX_SCOPE_KEY_LENGTH`).
- **client-ip (HIGH, behavior change)**: `X-Forwarded-For` is now resolved rightmost-untrusted — the chain is walked from the right past trusted proxy hops instead of trusting the (spoofable) leftmost entry; candidates must parse as IPs (IPv6-mapped IPv4 normalized to dotted-quad, also for `trustedProxies` matching), garbage falls back to the direct peer. New exports: `createClientIpResolver`, `normalizeIp`.
- **rate-limit (behavior change)**: `skipCidrs` now does real IPv4 CIDR matching (`a.b.c.d/nn`, bare IPs exact, IPv6-mapped normalization; invalid entries throw) instead of string-prefix matching; the internal-secret comparison is timing-safe; a warning is logged once when `keyByClientIp` is on but `clientIp` is missing (new optional `logger` option).
- **errors**: `statusErrorWithSet` whitelists the response body to `{ key, message[, fields] }` (extra error props are never serialized) and, like the `createErrorHandler` `ApiError` path, redacts 5xx messages in production (generic `Internal error`, stable `key` kept); production detection unified on the package's `isProduction()` (honors `PRODUCTION=true` without `NODE_ENV`).
- **security-headers**: headers are now applied to error responses too (staged in `onRequest`), `X-XSS-Protection` is `0`, and restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` defaults were added (all overridable/disable-able).
- **config**: `getEnvNumber` throws on non-numeric values (instead of returning `NaN`), `getEnvNumberOptional` returns `undefined`; `parseCorsOrigins(undefined) → true` documented as a deliberate fail-open dev default.
- **create-app**: graceful shutdown bounds `stop()` with a 10s (configurable `timeoutMs`) force-exit watchdog and logs + exits 1 on rejection instead of swallowing it.
