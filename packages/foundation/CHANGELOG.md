# @octabits-io/foundation

## 0.13.0

### Minor Changes

- [`9f37a5a`](https://github.com/octabits-io/platform/commit/9f37a5a6ed0461e2a97a10cb064a2ae73ea080ca) - `./utils` gains the last generic utility batch (reynt extraction-catalog items 25 + 24): `deepMerge`/`DeepPartial` (i18n-overlay merge semantics), `stripDefaults`, the full BCP-47 locale toolkit (`Locale`/`LocaleMap` types, `BCP47_LOCALE_REGEX`, `baseLocaleOf`, `localeFallbackChain`, `resolveLocale`/`resolveLocaleStrict`/`resolveLocaleOrAny`/`anyLocaleValue`, `matchLocaleTag`, `parseAcceptLanguage`, `negotiateContentLocale`, `isLocaleMapComplete`/`missingLocales`/`missingLocalesInUse`, `isLocaleMap`/`resolveLocaleDeep`), WCAG contrast helpers (`getContrastColor`, `getContrastTextMode`, `TAILWIND_COLOR_HEX`/`TAILWIND_COLOR_NAMES`), and `hashCyrb53` — previously a private copy inside `./ical`, now public (the ical fetcher imports it from utils).

## 0.12.2

### Patch Changes

- [`8cd4cee`](https://github.com/octabits-io/platform/commit/8cd4ceea7ba23bdad94ef13d3b241a8ad1bf3186) - Fix jsonb double-parse on read in `drizzle/scope` and `drizzle/idempotency`: stored JSON-string values whose content is itself valid JSON (e.g. a postal code `"73235"`, `"true"`) came back type-mangled (number/boolean) because Drizzle's stock `jsonb()` re-parses driver-parsed strings, making schema-validating readers drop the key. `scopedConfigColumns.value` and `idempotencyKeyColumns.responseBody` now use the new exported `jsonbSafe` custom type (same `jsonb` SQL type — zero DDL — and identical write serialization; reads trust the driver's parsing). Requires a driver that parses jsonb result columns itself, as node-postgres does by default.

## 0.12.1

### Patch Changes

- [`eae8882`](https://github.com/octabits-io/platform/commit/eae888215cf06b50c1da2a71f424966f7f8ec3f9) - Widen the `typescript` peer range to `^5 || ^6 || ^7` — the packages build and typecheck cleanly under TypeScript 7 (native compiler), and the emitted declarations are semantically identical to the TS 5/6 output.

## 0.12.0

### Minor Changes

- [`d660c14`](https://github.com/octabits-io/platform/commit/d660c14032440b2a805834121e73d7e7d49d301b) - Fold `@octabits-io/pii`, `@octabits-io/drizzle-toolkit`, and `@octabits-io/ical` into foundation as subpath exports. The three standalone packages are deprecated; their code moved here unchanged.

  Migration is a pure import-path rewrite:

  - `@octabits-io/pii` → `@octabits-io/foundation/pii`
  - `@octabits-io/drizzle-toolkit/<module>` → `@octabits-io/foundation/drizzle/<module>` (`db`, `factory`, `migrate`, `scope`, `crud`, `rls`, `idempotency`, `config`, `scoped-key-store`)
  - `@octabits-io/ical` → `@octabits-io/foundation/ical`

  Dependency changes on foundation: pii's `@noble/ciphers`/`@noble/curves`/`@noble/hashes`/`@scure/base` become hard dependencies; `drizzle-orm` (previously a hard dep of drizzle-toolkit), `pg`, and `ical.js` become optional peers used only by their respective subpaths. Consumers of `./drizzle/*` must declare `drizzle-orm` themselves (previously it came transitively).

  The changesets `linked` group (foundation/drizzle-toolkit/pii/flow) is dissolved — flow now versions independently.

## 0.11.0

### Minor Changes

- [`2ee205a`](https://github.com/octabits-io/platform/commit/2ee205a1af97b744fa1702ae44f0323181824fb2) - Absorb the `@octabits-io/vault` and `@octabits-io/captcha` micro-packages as foundation subpaths, and remove them as standalone packages.

  Both had a single real consumer (reynt) and only a few hundred LOC each, so a dedicated package, release cadence, and peer-dependency edge cost more than they returned. Folding them in shrinks the platform graph from 11 packages to 9 and removes two nodes from the changesets peer/version cascade.

  New subpath exports on `@octabits-io/foundation`:

  - `@octabits-io/foundation/vault` — the boot-time HashiCorp Vault KV-v2 secret loader (was `@octabits-io/vault`). No new dependencies; still plain `fetch`, `zod` peer only.
  - `@octabits-io/foundation/captcha` — the vendor-free captcha contract, error taxonomy, no-op transport, and ALTCHA config schema (was `@octabits-io/captcha`).
  - `@octabits-io/foundation/captcha/altcha` — the ALTCHA implementation. `altcha-lib` is now an **optional** peer of foundation (same pattern as the `jose` peer for `./auth`), so consumers that don't use ALTCHA never load it.

  **Migration for consumers of the old packages** (only reynt today):

  - `@octabits-io/vault` → `@octabits-io/foundation/vault`
  - `@octabits-io/captcha` → `@octabits-io/foundation/captcha`
  - `@octabits-io/captcha/altcha` → `@octabits-io/foundation/captcha/altcha`

  Drop `@octabits-io/vault` / `@octabits-io/captcha` from `dependencies` (foundation is already present). The already-published `@octabits-io/vault@0.3.0` and `@octabits-io/captcha@0.3.0` remain on npm, so existing installs keep working until they repoint. After this release, run `npm deprecate @octabits-io/vault "moved to @octabits-io/foundation/vault"` and `npm deprecate @octabits-io/captcha "moved to @octabits-io/foundation/captcha"`.

## 0.9.0

### Minor Changes

- [`b3513fa`](https://github.com/octabits-io/platform/commit/b3513fa128ff3b69b286c74d0589772125efe30a) - signing: add an optional `deriveInfo` seam to `createScopedSigningService`. It fully controls construction of the HKDF `info` string, letting a consumer reproduce a legacy key space's exact derived bytes and adopt the service without a key-rotation event (every already-issued signature stays verifiable). `ScopedSigningServiceConfig` is now an exclusive union: supply **either** `infoPrefix` (the safe length-prefixed default) **or** `deriveInfo` — never both. The default derivation is unchanged. A custom format with two or more variable segments must length-prefix each to stay collision-free.

## 0.8.0

### Minor Changes

- [`ed7813e`](https://github.com/octabits-io/platform/commit/ed7813e8274c1246ab694703d59ced0839b2e5d3) - New `./signing` subpath and API-key auth primitives in `./auth`.

  - `./signing`: `createScopedSigningService({ infoPrefix, scopeKey, keyStore })` — per-scope, per-purpose signing with HKDF domain separation (length-prefixed `${len}:${infoPrefix}|${len}:${purpose}|signing-key-v1` info strings), `hmac`/`verifyHmac`, `shortTag`/`verifyShortTag`, and `signJwt`/`verifyJwt` (jose optional peer, loaded lazily). The scope is an opaque string; keys live behind an injected `keyStore` read/write pair.
  - `./auth`: `createApiKeyFormat({ prefix })` — generate/parse/verify `<prefix><keyId>.<secret>` bearer tokens with SHA-256-at-rest secrets and constant-time verification; `createBearerAuthService({ strategies })` — ordered bearer-strategy dispatcher (`{ matches, validate }[]`) that routes API-key and JWT tokens through one entrypoint.

### Patch Changes

- [`513571d`](https://github.com/octabits-io/platform/commit/513571d069bac7ebd52234fcaf154aa8b1e8e315) - Review fixes across `./auth`, `./signing`, `./config-schema`, `./ioc`, `./result`, `./utils`, and `./logger`.

  - `./auth`: `jose` is now loaded lazily in `createJwtValidationService` (type-only imports + dynamic `import('jose')`, JWKS initialized on first validation), so the non-JWT auth surface (`createApiKeyFormat`, `createBearerAuthService`) works without jose installed. Token expiry is classified via jose's `ERR_JWT_EXPIRED` code (message fallback only for the exact `"exp" claim timestamp check failed` wording) — wrong-issuer/audience tokens no longer report `expired_token`. The E2E bypass secret compare is constant-time (`timingSafeEqual`). `jwtVerify` now pins accepted algorithms (new `algorithms` config option; defaults to the asymmetric RS/PS/ES/EdDSA families). `extractBearerToken` is a single shared helper, matches the `Bearer` scheme case-insensitively (RFC 7235), and tolerates multiple spaces.
  - `./signing`: HKDF info strings length-prefix `infoPrefix` and `purpose` (`${len}:${infoPrefix}|${len}:${purpose}|signing-key-v1`) so distinct pairs can never derive identical keys. `ensureProvisioned` serializes in-process read-modify-writes (cross-process races are recoverable via deterministic re-derive when `masterSecret` is set). `shortTag`/`verifyShortTag` validate `bytes` (integer 1..32, else `scoped_signing_invalid_bytes`) — `bytes: 0` can no longer make an empty tag verify. `verifyJwt` pins `algorithms: ['HS256']`.
  - `./config-schema`: new `booleanFromEnv()` replaces `z.coerce.boolean()` (which coerced `"false"`/`"0"` to `true`) for `logger`, RLS `enabled`, and `consoleOutput`; `nonEmptyUrl` uses `z.url()` and wires its custom `message` through.
  - `./ioc`: a container's own registration now takes precedence over the root singleton cache (singletons are cached on the owning container), so scope-level re-registrations are honored; the `toServices()` proxy no longer caches transient resolutions.
  - `./result`: `Result` re-export uses the `.ts` import extension; `toOctError` converts `Error` names to snake_case keys (`TypeError` → `type_error`); retry (`./utils`) clamps the backoff delay after jitter so it never exceeds `maxDelayMs`.
  - `./utils`: `LruCache` rejects `maxSize < 1` at construction (previously an infinite eviction loop); query-param int parsing is strict (radix 10, no trailing junk like `"12abc"`).
  - `./logger`: `consoleOutput` doc comment aligned with the actual default (`true`).

## 0.4.0

### Minor Changes

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
