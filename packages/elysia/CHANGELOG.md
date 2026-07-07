# @octabits-io/elysia

## 0.7.0

### Minor Changes

- [`ed7813e`](https://github.com/octabits-io/platform/commit/ed7813e8274c1246ab694703d59ced0839b2e5d3) - BREAKING (`./mcp`): `parseTenantId` removed in favor of `createPathSegmentScopeParser(segment)`, and `parseScopeKey` is now **required** — there is no default URL convention anymore, so the removal surfaces at compile time instead of as silent request rejection. Consumers that used the old default pass `parseScopeKey: createPathSegmentScopeParser('tenant')` to keep the `/tenant/:id/` layout; single-scope deployments pass `() => 'default'`.

- [`513571d`](https://github.com/octabits-io/platform/commit/513571d069bac7ebd52234fcaf154aa8b1e8e315) - Security & correctness fixes from review:

  - **mcp (HIGH)**: fixed a cross-request scope-container race — the `pendingContainer`/`activeContainer` closure singletons let concurrent requests see (and dispose) each other's scope. The harness now correlates the resolved scope to its request via `AsyncLocalStorage`: the outer route enters a request-private ALS context, `authentication` stages the scope into it, `getContainer()` reads it at tool-invocation time, and disposal runs in a `finally` tied to the request (exactly once, own container only).
  - **mcp**: `getContainer()` is now lazy and safe under elysia-mcp's eager mount-time `setupServer` call — `registerTools` runs once at startup (documented; must be idempotent) and a registration-time `getContainer()` call throws a clear error instead of silently poisoning every request.
  - **mcp**: `createPathSegmentScopeParser` now matches the segment's **last** occurrence in the path (an earlier client-controlled component can no longer shift extraction) and caps the extracted key at 256 chars (`MAX_SCOPE_KEY_LENGTH`).
  - **client-ip (HIGH, behavior change)**: `X-Forwarded-For` is now resolved rightmost-untrusted — the chain is walked from the right past trusted proxy hops instead of trusting the (spoofable) leftmost entry; candidates must parse as IPs (IPv6-mapped IPv4 normalized to dotted-quad, also for `trustedProxies` matching), garbage falls back to the direct peer. New exports: `createClientIpResolver`, `normalizeIp`.
  - **rate-limit (behavior change)**: `skipCidrs` now does real IPv4 CIDR matching (`a.b.c.d/nn`, bare IPs exact, IPv6-mapped normalization; invalid entries throw) instead of string-prefix matching; the internal-secret comparison is timing-safe; a warning is logged once when `keyByClientIp` is on but `clientIp` is missing (new optional `logger` option).
  - **errors**: `statusErrorWithSet` whitelists the response body to `{ key, message[, fields] }` (extra error props are never serialized) and, like the `createErrorHandler` `ApiError` path, redacts 5xx messages in production (generic `Internal error`, stable `key` kept); production detection unified on the package's `isProduction()` (honors `PRODUCTION=true` without `NODE_ENV`).
  - **security-headers**: headers are now applied to error responses too (staged in `onRequest`), `X-XSS-Protection` is `0`, and restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` defaults were added (all overridable/disable-able).
  - **config**: `getEnvNumber` throws on non-numeric values (instead of returning `NaN`), `getEnvNumberOptional` returns `undefined`; `parseCorsOrigins(undefined) → true` documented as a deliberate fail-open dev default.
  - **create-app**: graceful shutdown bounds `stop()` with a 10s (configurable `timeoutMs`) force-exit watchdog and logs + exits 1 on rejection instead of swallowing it.

## 0.6.0

### Minor Changes

- [`2526807`](https://github.com/octabits-io/platform/commit/2526807a76d996436357e657a7ff7678ed6d88d5) - `createRateLimit` accepts a `scoping` option (`'global'` | `'scoped'`), passed through to elysia-rate-limit. Use `scoping: 'scoped'` to mount a per-route limiter inside a route group — it guards only that group with its own counter, stacking with (and typically tighter than) the app-wide limit from the app skeleton, while keeping the standard client-IP keying and `{ key, message }` 429 body.

## 0.5.0

### Minor Changes

- [`691c2fc`](https://github.com/octabits-io/platform/commit/691c2fcfefacee90b0ef2beb519fec3a5b83d108) - Remove the deprecated tenant-named mcp aliases (breaking):

  - `resolveScope` no longer receives the `tenantId` alias — destructure
    `scopeKey` instead (`resolveScope: async ({ scopeKey, context }) => ...`).
  - `TENANT_ID_PATTERN` is gone — use `SCOPE_KEY_PATTERN`.
  - The `invalidTenantResponse` option is gone — use `invalidScopeResponse`.

  `parseTenantId` (the `/tenant/:tenantId/` path convention as the default
  `parseScopeKey`) is unchanged — it is the documented tenant preset, not a
  deprecated alias.

## 0.4.1

### Patch Changes

- Doc-comment cleanup: replace references to a specific consumer app with generic phrasing in the health, mcp, and Postgres storage provider docs. No behavior change.

## 0.4.0

### Minor Changes

- [`75c2fac`](https://github.com/octabits-io/platform/commit/75c2fac0e6e8080d45ed03e22aa4639856cc5ce9) - Add `createHealthRoutes` (root export): the `/health` liveness alias + `/live` +
  `/ready` route trio every API duplicates, plus the `onError` that maps `/ready`
  failures to a `503` with `{ status: 'error', message }`. The readiness probe is
  the injected `checkReady: () => Promise<void>` seam (reynt passes a
  `SELECT 1`-via-Drizzle closure) — no db/container coupling. Response bodies are
  byte-equivalent to the reynt routes: `{ status: 'ok' }` (liveness) and
  `{ status: 'ok', db: 'connected' }` (readiness). `prefix`, `tags`,
  `readyErrorMessage`, and an optional foundation `Logger` are configurable. Also
  exports the `SCHEMA_HEALTH_LIVE_RESPONSE` / `SCHEMA_HEALTH_READY_RESPONSE` zod
  schemas.

- [`75c2fac`](https://github.com/octabits-io/platform/commit/75c2fac0e6e8080d45ed03e22aa4639856cc5ce9) - Add `./mcp` subpath (`@octabits-io/elysia/mcp`): `createMcpRoutes`, the
  per-request container harness both reynt MCP routes duplicate around
  `elysia-mcp` in stateless mode. It owns the `pendingContainer` staging, the
  `WeakMap<McpServer, scope>` handoff, per-request scope acquire, tenant-id
  path parsing (`/^[a-zA-Z0-9-_]+$/`), and scope disposal on
  `onAfterResponse`/`onError`. The auth differences (operator superadmin-grant
  synthesis vs. the simpler customer flow) become the injected `resolveScope`
  seam, and tool registration the `registerTools(server, getContainer)` seam.
  Also exports `parseTenantId`, `jsonRpcError`, and `TENANT_ID_PATTERN`.
  `elysia-mcp` and `@modelcontextprotocol/sdk` are OPTIONAL peers, so the root
  export stays free of them.

- [`d517615`](https://github.com/octabits-io/platform/commit/d5176151616574ce7e653c3e9b4942b8c8d92f7c) - Make the platform packages tenancy-agnostic: multi-tenancy becomes one way to
  use each API instead of a structural requirement.

  **storage (BREAKING)**: the required per-call `tenant: string` is now an
  optional `namespace?: string` on every `ObjectStorageService` /
  `ObjectStorageUrlProvider` / `ObjectFileServer` method — omit it for
  single-partition deployments. S3 keys default to `<namespace>/<key>` (no more
  hardcoded `tenant/` segment); pass `` namespacePrefix: ns => `tenant/${ns}/`  ``
  on the S3 configs to keep existing bucket layouts. The Postgres provider renames
  its column `tenant_id` → `namespace` (the table initializer migrates existing
  tables in place, data preserved; root namespace stored as `''`), and
  `createPublicUrl` now receives `(namespace: string | undefined, key)`. The
  Postgres HTTP handlers take an optional `namespace` accordingly. Picsum's
  `defaultQuery` placeholder default is now domain-neutral.

  **drizzle-toolkit**: `crud` gains `createBaseCrudService` (no scoping, any
  table with `id`) and `createScopedCrudService` (generic
  `scope: { column, value }` row isolation). `createBaseTenantScopedCrudService`
  is unchanged — now a thin preset of the scoped variant
  (`scope: { column: 'tenantId', ... }`).

  **elysia**: `createMcpRoutes` scope extraction is pluggable via
  `parseScopeKey?: (url) => string | null` (default remains the
  `/tenant/:tenantId/` convention; single-scope servers can pass
  `() => 'default'`). `resolveScope` receives `scopeKey` (with `tenantId` kept
  as a deprecated alias), and `invalidScopeResponse` supersedes the deprecated
  `invalidTenantResponse`. Default rejection message is now "Invalid scope key".

  **queue**: new `SCHEMA_SYSTEM_JOB_PAYLOAD` / `SystemJobPayload` base for
  global/cron jobs — no more `'__system__'` sentinel tenant ids;
  `SCHEMA_TENANT_JOB_PAYLOAD` now extends it.

  **foundation**: `SystemScopeFactory` is partition-agnostic — its parameter is
  an optional `scopeKey?: string` (previously required `tenantId: string`).

  **pii**: `createTenantKeyService` now detects the concurrent key-generation
  race via SQLSTATE 23505 (walking the error `cause` chain) instead of matching
  `'unique'` in error messages; `TenantKeyGenerationError` gains a `conflict`
  flag.

## 0.3.0

### Minor Changes

- [`30d334d`](https://github.com/octabits-io/platform/commit/30d334d8241f616d1de2b921b8f11165fa554332) - New **`createElysiaApp(routes, options)`** — the standard app skeleton every API repeated: `securityHeaders → clientIp → rateLimit → [caller plugins: cors/swagger] → errorHandler → routes`, each stage toggleable, with the routes' type preserved for Eden Treaty `type App` inference. cors/swagger are passed as ready-built plugin instances so this package stays free of `@elysiajs/*` deps. Plus **`registerGracefulShutdown({ logger, stop, signals? })`** — the SIGTERM/SIGINT → teardown → `exit(0)` tail duplicated in every `main()`.

- [`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574) - Add `createRateLimit` plugin factory: a domain-agnostic wrapper around
  `elysia-rate-limit` reproducing the standard API rate-limit config (fixed window
  keyed on `derived.clientIp`, `{ key, message }` 429 JSON body) with a
  parameterized skip seam — bypass by internal-secret header **or** trusted CIDR
  prefix. Options: `max`, `windowMs`, `skipCidrs`, `internalSecret`,
  `internalSecretHeader`, `keyByClientIp`, `errorKey`, `errorMessage`.

- [`da30c8e`](https://github.com/octabits-io/platform/commit/da30c8e13918dc5d25a9655e45f085f6d954a9bb) - New package **`@octabits-io/elysia`** — reusable Elysia middleware & helpers extracted from production APIs, with zero domain coupling:

  - `createSecurityHeadersPlugin(options?)` — standard hardening response headers (configurable CSP/HSTS). Uses `as: 'global'` so headers apply to every response.
  - `createClientIpPlugin(trustedProxies)` — trusted-proxy `X-Forwarded-For` resolution → `clientIp`.
  - Error mapping: `getStatusCodeForError` / `statusErrorWithSet` / `mapResultError` (with injectable `statusOverrides`), the `ApiError` class family, `isDbConnectionError`, and the `createErrorHandler` global plugin.
  - Response schemas: `SCHEMA_ERROR_RESPONSE` / `SCHEMA_VALIDATION_ERROR` / `SCHEMA_SUCCESS_RESPONSE`, the `CommonErrorResponses` superset, and the `errorResponses(...codes)` selector.
  - Config helpers: typed `process.env` accessors (`getEnv` / `getEnvOptional` / `getEnvNumber` / `getEnvNumberOptional` / `getEnvBoolean` / `isProduction`) plus `parseCsv` (trusted proxies / skip-CIDRs) and `parseCorsOrigins`.

  `@octabits-io/foundation` is a **peer dependency** (static range `>=0.2.0 <1`): errors are foundation's `OctError` (`KeyedError` remains as an alias) and `createErrorHandler` takes foundation's `Logger`. This package is part of the octabits stack, not a standalone kit — consumers already have foundation.
