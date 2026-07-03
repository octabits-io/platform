---
"@octabits-io/elysia": minor
---

New package **`@octabits-io/elysia`** — reusable Elysia middleware & helpers extracted from production APIs, with zero domain coupling:

- `createSecurityHeadersPlugin(options?)` — standard hardening response headers (configurable CSP/HSTS). Uses `as: 'global'` so headers apply to every response.
- `createClientIpPlugin(trustedProxies)` — trusted-proxy `X-Forwarded-For` resolution → `clientIp`.
- Error mapping: `getStatusCodeForError` / `statusErrorWithSet` / `mapResultError` (with injectable `statusOverrides`), the `ApiError` class family, `isDbConnectionError`, and the `createErrorHandler` global plugin.
- Response schemas: `SCHEMA_ERROR_RESPONSE` / `SCHEMA_VALIDATION_ERROR` / `SCHEMA_SUCCESS_RESPONSE`, the `CommonErrorResponses` superset, and the `errorResponses(...codes)` selector.
- Config helpers: typed `process.env` accessors (`getEnv` / `getEnvOptional` / `getEnvNumber` / `getEnvNumberOptional` / `getEnvBoolean` / `isProduction`) plus `parseCsv` (trusted proxies / skip-CIDRs) and `parseCorsOrigins`.
