# @octabits-io/foundation

## 0.3.0

### Minor Changes

- [`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574) - Add the `@octabits-io/foundation/auth` subpath: generic OIDC/JWT validation.
  `createJwtValidationService<TToken>({ issuerUrl, audience, logger, claimMapper,
authBypassSecret?, bypassToken? })` performs lazy OIDC discovery (with a 30s
  discovery-failure cooldown), JWKS-backed signature verification via `jose`
  (`createRemoteJWKSet` + `jwtVerify`, issuer/audience checked), and hands the verified
  payload to an injected `claimMapper(payload) => ClaimMapperResult<TToken>` so all
  provider-specific (e.g. Zitadel) claim knowledge stays in the consumer. Includes the
  production-neutralized auth-bypass path (returns a caller-supplied `bypassToken`),
  `extractBearerToken`, and `validateAuthorizationHeader`. Exports the `JwtValidationService`,
  `JwtValidationServiceConfig`, `JwtValidationError`, `ValidateResult`, `ClaimMapper`, and
  `ClaimMapperResult` types. `jose ^6` is an **optional peer dependency** — only consumers
  importing the `./auth` subpath need to install it; the other foundation subpaths stay
  dependency-free.

- [`d457103`](https://github.com/octabits-io/platform/commit/d457103625196712bc963f7d49a29ecbbcd42492) - New subpath **`@octabits-io/foundation/config-schema`** — reusable Zod fragments for backend service-container config schemas, extracted from the triplicated sections that every container repeated verbatim:

  - `nonEmptyString` / `nonEmptyUrl` — the two string primitives every config is built from.
  - `DATABASE_CONFIG_SCHEMA` — connection URL + pool knobs (`poolMaxConnections`, idle/connection/statement timeouts). RLS is deliberately excluded (surface-specific defaults) and composed via `createRlsSchema(defaultEnabled)` + `.extend(...)`.
  - `LOGGING_CONFIG_SCHEMA` — log level + optional OTLP export config.

  App-specific sections (storage, auth/OIDC field sets, captcha, domain config) intentionally stay in each app — captcha in particular is a product choice (ALTCHA), not foundation.

- [`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574) - Add the `@octabits-io/foundation/rbac` subpath: a small, dependency-free RBAC engine.
  Exports `createRole(permissions)` → `{ permissions, authorize(requested) }` (pure
  resource/action subset check) and `checkLocalPermission(roles, roleName, permissions)`
  against a caller-supplied role registry. Generic over a caller-supplied permission
  `Statement` type — the concrete statement matrix, named roles, and derived
  permission-request types stay in the consuming application. Also exports the
  `Statement`, `RolePermissions`, `Role`, and `AuthorizeResult` types.

- [`f538ade`](https://github.com/octabits-io/platform/commit/f538ade424900afb3ba4c5ab3719648c9bd73574) - Extend the `@octabits-io/foundation/utils` subpath with three widely-used platform
  utilities:

  - `createDateProvider()` / `DateProvider` — the `{ now(): Date }` clock-injection seam.
  - `createLruCacheService({ dateProvider })` → `.createCache<K, V>({ maxSize, ttlMs })` —
    a generic LRU + TTL cache over a `Map`, depending only on `DateProvider`. Also exports
    `LruCache`, `LruCacheOptions`, `LruCacheService`, `LruCacheServiceDeps`.
  - `withRetry()` — exponential-backoff-with-jitter retry helper. Its `Logger` dependency
    is a structural/injected type (from `@octabits-io/foundation/logger`), so it does not
    hard-depend on any concrete logger. Also exports `RetryConfig` / `RetryOptions`.

## 0.2.0

### Minor Changes

- [`ef2238e`](https://github.com/octabits-io/platform/commit/ef2238e3549096c88b3c48e539f5faef4d9d5e30) - IoC: `dispose()` now runs all remaining disposables even when one throws (single error rethrown, multiple wrapped in `AggregateError`) — previously a throwing disposable skipped the rest and leaked resources. Disposables also receive a new `DisposeOptions` argument (`{ commit: boolean }`, default `{ commit: true }`) so scope teardown can signal commit vs rollback to transaction-holding services.

- Widened `typescript` peer range to `^5 || ^6`.

## 0.1.4

### Patch Changes

- Reorganize monorepo directory structure for open core model and fix CJS export compatibility in foundation

## 0.1.3

### Patch Changes

- Add `ok()` and `err()` Result constructors, standardize naming conventions across all packages

## 0.1.1

### Patch Changes

- [`ebd810d`](https://github.com/octabits-io/platform/commit/ebd810d0057374ef1b534c0a287270b710c3a30d) - Initial release with Result pattern, IoC container, logger, and utilities (foundation); PII encryption with AES-256-GCM and X25519/age hybrid encryption (pii); Drizzle error handling, cursor pagination, and DAG-based workflow engine (drizzle-toolkit); Vitest global setup and per-suite helpers with testcontainers for Drizzle (drizzle-test).
