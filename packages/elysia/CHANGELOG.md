# @octabits-io/elysia

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
