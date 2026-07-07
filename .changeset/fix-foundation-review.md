---
'@octabits-io/foundation': patch
---

Review fixes across `./auth`, `./signing`, `./config-schema`, `./ioc`, `./result`, `./utils`, and `./logger`.

- `./auth`: `jose` is now loaded lazily in `createJwtValidationService` (type-only imports + dynamic `import('jose')`, JWKS initialized on first validation), so the non-JWT auth surface (`createApiKeyFormat`, `createBearerAuthService`) works without jose installed. Token expiry is classified via jose's `ERR_JWT_EXPIRED` code (message fallback only for the exact `"exp" claim timestamp check failed` wording) — wrong-issuer/audience tokens no longer report `expired_token`. The E2E bypass secret compare is constant-time (`timingSafeEqual`). `jwtVerify` now pins accepted algorithms (new `algorithms` config option; defaults to the asymmetric RS/PS/ES/EdDSA families). `extractBearerToken` is a single shared helper, matches the `Bearer` scheme case-insensitively (RFC 7235), and tolerates multiple spaces.
- `./signing`: HKDF info strings length-prefix `infoPrefix` and `purpose` (`${len}:${infoPrefix}|${len}:${purpose}|signing-key-v1`) so distinct pairs can never derive identical keys. `ensureProvisioned` serializes in-process read-modify-writes (cross-process races are recoverable via deterministic re-derive when `masterSecret` is set). `shortTag`/`verifyShortTag` validate `bytes` (integer 1..32, else `scoped_signing_invalid_bytes`) — `bytes: 0` can no longer make an empty tag verify. `verifyJwt` pins `algorithms: ['HS256']`.
- `./config-schema`: new `booleanFromEnv()` replaces `z.coerce.boolean()` (which coerced `"false"`/`"0"` to `true`) for `logger`, RLS `enabled`, and `consoleOutput`; `nonEmptyUrl` uses `z.url()` and wires its custom `message` through.
- `./ioc`: a container's own registration now takes precedence over the root singleton cache (singletons are cached on the owning container), so scope-level re-registrations are honored; the `toServices()` proxy no longer caches transient resolutions.
- `./result`: `Result` re-export uses the `.ts` import extension; `toOctError` converts `Error` names to snake_case keys (`TypeError` → `type_error`); retry (`./utils`) clamps the backoff delay after jitter so it never exceeds `maxDelayMs`.
- `./utils`: `LruCache` rejects `maxSize < 1` at construction (previously an infinite eviction loop); query-param int parsing is strict (radix 10, no trailing junk like `"12abc"`).
- `./logger`: `consoleOutput` doc comment aligned with the actual default (`true`).
