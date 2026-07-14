# @octabits-io/framework — base modules

The framework's foundation tier, providing core primitives used across the platform: error handling, dependency injection, structured logging, common utilities, Zod config fragments, an RBAC engine, OIDC/JWT validation, per-scope signing, a Vault secret loader, a captcha contract, PII encryption (`./pii`), Drizzle ORM utilities (`./drizzle/*`), and iCal ingestion (`./ical`).

## Modules

### `@octabits-io/framework/result`

Type-safe error handling using the Result pattern — no thrown exceptions.

```ts
import type { Result, OctError } from '@octabits-io/framework/result';
import { ok, err, tryCatch, tryCatchAsync, isOctError, toOctError } from '@octabits-io/framework/result';

// Result<T, E> is { ok: true; value: T } | { ok: false; error: E }
function divide(a: number, b: number): Result<number> {
  if (b === 0) return err({ key: 'division_by_zero', message: 'Cannot divide by zero' });
  return ok(a / b);
}

// Wrap throwing code into a Result
const result = tryCatch(() => JSON.parse(input));
const asyncResult = await tryCatchAsync(() => fetch(url));

if (result.ok) {
  console.log(result.value);
} else {
  console.log(result.error.message); // OctExceptionError with key 'exception'
}
```

**API error types** — discriminated union for HTTP error responses:

`ValidationApiError`, `NotFoundApiError`, `BadRequestApiError`, `UnauthorizedApiError`, `ForbiddenApiError`, `InternalApiError`, `ApiErrorResponse`

---

### `@octabits-io/framework/ioc`

Lightweight IoC container with singleton, scoped, and transient lifetimes.

```ts
import { IoC, ServiceLifetime } from '@octabits-io/framework/ioc';

type Services = {
  db: Database;
  logger: Logger;
  userRepo: UserRepo;
};

const container = new IoC<Services>();
container.register('db', () => new Database(), ServiceLifetime.Singleton);
container.register('logger', () => new Logger(), ServiceLifetime.Singleton);
container.register('userRepo', (c) => new UserRepo(c.resolve('db')), ServiceLifetime.Scoped);

// Create a request-scoped child container
const scope = container.createScope();
const repo = scope.resolve('userRepo'); // new instance per scope
const db = scope.resolve('db');         // shared singleton

// Cleanup scoped resources
scope.onDispose(() => repo.close());
await scope.dispose();

// Proxy object for convenient access
const services = container.toServices();
services.db; // resolves on property access
```

**Key types:** `ServiceResolver<T>`, `DisposableServiceResolver<T>`, `SystemScopeFactory<T>`,
`ErasedScope` (type-erased `resolve`-by-string + `dispose` — the circular-dependency
dodge modules otherwise re-declare inline).

**Scope lifecycle helpers** — for non-HTTP contexts (queue handlers, cron sweeps,
CLI); the Elysia request path has `createRequestScopePlugin` instead:

```ts
import { withScope, forEachScope } from '@octabits-io/framework/ioc';

// acquire → work → dispose, with the request-scope plugin's commit semantics:
// success → dispose({ commit: true }) (a failure here RETHROWS — the work may
// not be persisted); fn threw → dispose({ commit: false }), fn's error wins.
const total = await withScope(
  () => createSystemScope(),
  async (scope) => scope.resolve('sweepService').run(),
);

// Fan out over many scopes with failure isolation: one broken key records an
// error and the sweep continues. Returns { processed, failed } for the tally.
const { processed, failed } = await forEachScope(
  { keys: scopeKeys, createScope: (key) => createSystemScope(key), onError: log },
  async (scope, key) => scope.resolve('sweepService').runFor(key),
);
```

---

### `@octabits-io/framework/logger`

Structured logging with OpenTelemetry-compatible output.

```ts
import { createLoggerService } from '@octabits-io/framework/logger';

const loggerService = createLoggerService({
  config: {
    serviceName: 'my-api',
    serviceVersion: '1.0.0',
    environment: 'production', // JSON output; 'development' for human-readable
    logLevel: 'info',
  },
});

const logger = loggerService.logger;
logger.info('Server started', { port: 3000 });
logger.error('Request failed', error, { requestId: 'abc123' });

// Child loggers carry context
const reqLogger = logger.child({ requestId: 'abc123' });
reqLogger.info('Processing'); // includes requestId in all messages
```

---

### `@octabits-io/framework/utils`

Common utility functions.

```ts
import { slugify, isUrlFriendly } from '@octabits-io/framework/utils';
import { tryDecodeBase64 } from '@octabits-io/framework/utils';
import { normalizeQueryParamToStringOrUndefined } from '@octabits-io/framework/utils';

slugify('Héllo Wörld!'); // 'hello-world'
isUrlFriendly('my-slug_01'); // true

const decoded = tryDecodeBase64('aGVsbG8='); // Result<string>

// Normalize framework query params (string | string[] | null | undefined)
normalizeQueryParamToStringOrUndefined(['foo', 'bar']); // 'foo'
normalizeQueryParamToIntOrUndefined('42'); // 42
normalizeQueryParamToArrayOrUndefined('single'); // ['single']
```

Also exported: `createDateProvider` / `DateProvider` (clock-injection seam),
`createLruCacheService` (bounded LRU cache), `withRetry` (backoff retries,
`RetryConfig` / `RetryOptions`), and `URL_FRIENDLY_REGEX`.

BCP-47 locale toolkit (`Locale` / `LocaleMap<T>` — sparse tag→value maps):

```ts
import { resolveLocale, negotiateContentLocale, deepMerge } from '@octabits-io/framework/utils';

// Fallback chain: requested → base language → default → default's base.
// A de-formal request with only a `de` value resolves to the `de` value.
resolveLocale({ en: 'Hello', de: 'Hallo' }, 'de-formal', 'en'); // 'Hallo'

// Route hint → Accept-Language → default, matched against supported tags
negotiateContentLocale({
  hint: 'de',
  acceptLanguage: 'de-DE,en;q=0.5',
  supported: ['en', 'de-formal'],
  defaultLocale: 'en',
}); // 'de-formal'

// i18n-overlay merge: override leaves win, arrays replace wholesale
deepMerge({ common: { ok: 'OK', cancel: 'Cancel' } }, { common: { cancel: 'Abbrechen' } });
```

Full locale surface: `BCP47_LOCALE_REGEX`, `baseLocaleOf`, `localeFallbackChain`,
`resolveLocale` / `resolveLocaleStrict` / `resolveLocaleOrAny` / `anyLocaleValue`,
`matchLocaleTag`, `parseAcceptLanguage`, `negotiateContentLocale`,
`isLocaleMapComplete` / `missingLocales` / `missingLocalesInUse`, `isLocaleMap`,
`resolveLocaleDeep`. Plus `stripDefaults` (omit default/empty values before
persisting), WCAG contrast helpers (`getContrastColor`, `getContrastTextMode`,
`TAILWIND_COLOR_HEX` / `TAILWIND_COLOR_NAMES`), and `hashCyrb53` (fast
**non-cryptographic** 53-bit hash for change detection).

---

### `@octabits-io/framework/config-schema`

Reusable Zod config fragments — compose them into your app's config schema.

```ts
import {
  nonEmptyString,
  nonEmptyUrl,
  booleanFromEnv,
  DATABASE_CONFIG_SCHEMA,
  createRlsSchema,
  LOGGING_CONFIG_SCHEMA,
  MAIL_CONFIG_SCHEMA,
  createConfigParser,
} from '@octabits-io/framework/config-schema';

const CONFIG_SCHEMA = z.object({
  database: DATABASE_CONFIG_SCHEMA,
  rls: createRlsSchema(true), // default-enabled RLS toggle
  logging: LOGGING_CONFIG_SCHEMA,
  mail: MAIL_CONFIG_SCHEMA,
  apiUrl: nonEmptyUrl(),
});
```

Use `booleanFromEnv()` for env-sourced flags rather than `z.coerce.boolean()`,
which treats every non-empty string — including `"false"` and `"0"` — as `true`.

#### Mail

`MAIL_CONFIG_SCHEMA` is a discriminated union on `mode`:

| `mode` | Fields |
| --- | --- |
| `logger` | — (pairs with the logger/in-memory transports the `./mail` root ships) |
| `smtp` | `host`, `port`, `secure` (default `false`), `user`, `password` |
| `mailjet` | `apiKey`, `apiSecret` |
| `brevo` | `apiKey` |

Every mode also carries the platform identity and delivery-safety fields —
`platformFromAddress` (required), `platformFromName?`,
`platformNotificationsAddress?`, `forceNotificationsOnlyDelivery?`, and
`devOverrideRecipient?` — named to match `createBaseMailService`'s config, so a
parsed section spreads straight into it. They are shared across *all* modes
(including `logger`), so flipping `mode` in an env file never invalidates the
rest of the section.

#### Parsing

`createConfigParser(schema)` wraps a composed schema into a `Result`-returning
parser — the Result-pattern counterpart to `schema.parse` (throws) and
`schema.safeParse` (whose `ZodError` is not an `OctError`):

```ts
export const parseAppConfig = createConfigParser(CONFIG_SCHEMA);

const parsed = parseAppConfig(raw);
if (!parsed.ok) throw new Error(parsed.error.message); // boot-time: fail loud
```

Failures are `err({ key: 'config_invalid', message })`, where `message`
aggregates **every** issue as `path: message` (dotted paths, `<root>` for a
top-level issue) — one parse reports all problems, not just the first. Values
are never echoed into the message: config holds secrets, and the message is
expected to reach logs.

---

### `@octabits-io/framework/rbac`

Self-contained, dependency-free RBAC engine: pure resource/action subset
checking, generic over a caller-supplied permission statement. The concrete
statement matrix and named roles live in the consuming application.

```ts
import { createRole, checkLocalPermission } from '@octabits-io/framework/rbac';

const statement = {
  article: ['read', 'write', 'delete'],
  settings: ['read', 'write'],
} as const;

const editor = createRole<typeof statement>({
  article: ['read', 'write'],
  settings: ['read'],
});

editor.authorize({ article: ['write'] }); // { success: true }
checkLocalPermission(editor, { settings: ['write'] }); // false
```

---

### `@octabits-io/framework/auth`

Generic OIDC/JWT validation (optional peer: `jose`). Lazily discovers the JWKS
URI from the issuer's OIDC discovery document, verifies signatures via
`createRemoteJWKSet` (cached, rotation-aware), and hands verified payloads to a
caller-supplied `claimMapper` that produces your domain token shape.

```ts
import { createJwtValidationService } from '@octabits-io/framework/auth';

const jwtService = createJwtValidationService<MyToken>({
  issuerUrl: 'https://auth.example.com',
  audience: 'my-api',
  logger,
  claimMapper: (payload) => ({ ok: true, value: { userId: payload.sub! } }),
  // optional E2E bypass (neutralized in production):
  // authBypassSecret, bypassToken
});

const result = await jwtService.validateAuthorizationHeader(req.headers.authorization);
if (result.ok) console.log(result.value.userId);

jwtService.extractBearerToken('Bearer abc'); // 'abc'
```

**API key format** — issue and verify `<prefix><keyId>.<secret>` bearer tokens.
Pure `node:crypto`, no I/O: `keyId` enables O(1) row lookup, only the secret's
SHA-256 hash is persisted, and `verifyHash` compares in constant time.

```ts
import { createApiKeyFormat } from '@octabits-io/framework/auth';

const apiKeys = createApiKeyFormat({ prefix: 'acme_' });

const keyId = apiKeys.generateKeyId();
const secret = apiKeys.generateSecret();
const token = apiKeys.formatToken(keyId, secret);   // 'acme_<keyId>.<secret>'
const storedHash = apiKeys.hashSecret(secret);       // persist this + keyId
const publicPrefix = apiKeys.deriveKeyPrefix(keyId); // 'acme_<keyId>' — safe to show

// On an incoming request:
const parsed = apiKeys.parseToken(token);            // { keyId, secret } | null
if (parsed) {
  // look up the row by parsed.keyId, then:
  apiKeys.verifyHash(parsed.secret, storedHash);     // constant-time boolean
}
```

**Bearer dispatcher** — one entrypoint for any `Authorization: Bearer ...`
header. Strategies are tried in order; the first whose `matches` returns `true`
owns the token. All strategies return the shared `Result` shape, so callers stay
agnostic to which one ran.

```ts
import { createBearerAuthService } from '@octabits-io/framework/auth';

const bearer = createBearerAuthService<MyPrincipal>({
  strategies: [
    { matches: (t) => apiKeys.isApiKeyToken(t), validate: (t) => validateApiKey(t) },
    { matches: () => true, validate: (t) => jwtService.validateToken(t) }, // fallback
  ],
});

const result = await bearer.validateAuthorizationHeader(req.headers.authorization);
// { ok: false, error: { key: 'missing_token' | 'no_matching_strategy' } } when unhandled
```

---

### `@octabits-io/framework/signing`

Generic per-scope, per-purpose signing (optional peer: `jose`, loaded lazily and
only for the JWT primitives). One service for HMAC/JWT crypto, HKDF key
derivation, and constant-time comparison — so no consumer re-rolls its own. The
`scopeKey` is an opaque string feeding HKDF domain separation (not a DB column);
each `purpose` gets its own 256-bit key. Keys live behind an injected `keyStore`.

```ts
import { createScopedSigningService } from '@octabits-io/framework/signing';

const signing = createScopedSigningService({
  infoPrefix: 'acme',                 // → length-prefixed HKDF info `4:acme|5:reply|signing-key-v1`
  scopeKey: tenantId,                 // opaque salt for domain separation
  keyStore: { read, write },          // your `purpose → base64-key` persistence
  masterSecret: process.env.SIGNING_MASTER_SECRET, // optional; enables derive + JWT signing
});

// Full-length detached HMAC (base64url)
const sig = await signing.hmac('reply', message);          // Result<string>
await signing.verifyHmac('reply', message, sig.value);     // Result<boolean> (constant-time)

// Length-constrained hex tag (default 12 bytes / 24 hex chars)
const tag = await signing.shortTag('reply', conversationId);
await signing.verifyShortTag('reply', conversationId, tag.value);

// Self-contained HS256 token (auto-provisions the key into keyStore)
const jwt = await signing.signJwt('booking', { bookingId }, { expiresAt });
await signing.verifyJwt('booking', jwt.value);             // Result<JWTPayload>
```

With a `masterSecret`, keys are HKDF-derived on the fly (no store round-trip, and
verifiable before any lookup). Without one, the service is read-only against
`keyStore` — verifying, and signing under, keys a provisioning path wrote
earlier; signing an unprovisioned purpose returns `scoped_signing_key_not_found`.
Errors are `Result` values (`scoped_signing_key_not_found`,
`scoped_signing_signature_invalid`), never thrown.

#### `constantTimeEquals`

Constant-time string comparison for secrets an attacker can submit repeatedly
and time — URL path secrets, webhook tokens, HMAC digests:

```ts
import { constantTimeEquals } from '@octabits-io/framework/signing';

if (!constantTimeEquals(params.secret, expectedSecret)) return unauthorized();
```

`node:crypto`'s `timingSafeEqual` throws on a length mismatch, so callers reach
for `a.length === b.length && timingSafeEqual(...)` — a guard that
short-circuits, leaking the secret's length one probe at a time. This helper
SHA-256s both inputs first, so the comparison always runs over two 32-byte
digests and no branch depends on input length. Inputs are treated as UTF-8; no
Unicode normalization is applied (it is for secrets, not user-visible text).

### `@octabits-io/framework/vault`

Boot-time HashiCorp Vault secret loader — hydrates `process.env` from KV-v2
paths declared in a JSON manifest, before config loads. Plain `fetch`, no SDK.
(Formerly the standalone `@octabits-io/vault` package.)

```ts
import { loadVaultSecrets, parseSecretManifest } from '@octabits-io/framework/vault';

const manifest = parseSecretManifest(await readFile('secrets.json', 'utf8'));
await loadVaultSecrets(manifest); // populates process.env from Vault KV-v2
```

### `@octabits-io/framework/captcha`

Provider-agnostic captcha contract (challenge → redeem → verified-token →
validate) with a no-op implementation for dev/test and the ALTCHA config schema.
The root entry is vendor-free; the ALTCHA proof-of-work implementation lives
behind `@octabits-io/framework/captcha/altcha` so `altcha-lib` (an optional
peer) is only loaded when used. (Formerly the standalone `@octabits-io/captcha`
package.)

```ts
import { createNoopCaptchaService, CAPTCHA_CONFIG_SCHEMA } from '@octabits-io/framework/captcha';
import { createAltchaCaptchaService } from '@octabits-io/framework/captcha/altcha';
```

### `@octabits-io/framework/pii`

Encryption toolkit for Personally Identifiable Information (PII). Uses [age encryption](https://age-encryption.org/) (X25519 + ChaCha20-Poly1305) with a built-in TypeScript implementation. (Formerly the standalone `@octabits-io/pii` package.)

#### PII Encryption Service

High-level service for encrypting/decrypting PII fields. Inject once with keys, use everywhere.

```ts
import { createPiiEncryptionService, createPiiEncryptionOnlyService } from '@octabits-io/framework/pii';

// Full encrypt + decrypt (backend services with access to the secret key)
const pii = createPiiEncryptionService({
  recipient: 'age1...', // public key
  identity: 'AGE-SECRET-KEY-1...', // private key
});

const encrypted = await pii.encryptString('john@example.com');
const decrypted = await pii.decryptString(encrypted.value);

// JSON values with Zod validation on decrypt
const encJson = await pii.encryptJson({ street: '123 Main St', city: 'Berlin' });
const decJson = await pii.decryptJson(encJson.value, AddressSchema);

// Encrypt-only variant (e.g., ingestion services that don't need to read PII)
const encryptOnly = createPiiEncryptionOnlyService({ recipient: 'age1...' });
```

All methods return `Result<T, PiiEncryptionError | PiiDecryptionError>` and pass through `null`/`undefined` inputs.

#### Blind Index

HMAC-SHA256 blind indexes for exact-match search on encrypted fields without exposing plaintext.

```ts
import { createBlindIndexService } from '@octabits-io/framework/pii';

const blindIndex = createBlindIndexService(process.env.BLIND_INDEX_KEY);

// Store alongside encrypted data for lookups
const emailIndex = blindIndex.generateIndex('john@example.com'); // Buffer (HMAC-SHA256)

// Later: WHERE email_blind_index = $1
```

#### Master Key Provider

Envelope encryption pattern — encrypt data keys at rest with a master key derived via HKDF-SHA256.

```ts
import { createEnvVarMasterKeyProvider } from '@octabits-io/framework/pii';

const masterKey = createEnvVarMasterKeyProvider(process.env.MASTER_KEY);

const wrapped = await masterKey.encrypt(dataKeyBuffer);
const unwrapped = await masterKey.decrypt(wrapped.value);
```

`MASTER_KEY` must be **cryptographically random material, not a passphrase** — HKDF derives a fixed-size key but does no password stretching, so a human-chosen value is brute-forceable no matter how it's derived. Generate one with:

```bash
openssl rand -base64 32
```

`createEnvVarMasterKeyProvider` throws at startup if the source is shorter than 32 characters. Note this is a length check only — it cannot detect a long-but-guessable passphrase, so always use a generated value.

#### Scoped Key Service

Per-scope key management: lazily generates an Age keypair + blind-index HMAC
key per scope, stores them master-key-encrypted, and serves decrypted keys
through a cache. Generic over the scope column — the consumer picks it. A
multi-tenant consumer binds the scope to its own `tenantId` column
(`scope: { column: 'tenantId', value: tenantId }`); a single-tenant or
differently-partitioned consumer picks `orgId`, `workspaceId`, `ownerId`, ….

**Storage is a structural seam, not a database.** The service depends on a
four-method `ScopedKeyStore` (`insert` / `find` / `exists` / `destroy`),
scope-bound at construction — it owns the encryption logic and knows nothing
about SQL, drivers, or ORMs (so `@octabits-io/framework/pii` has **no `drizzle-orm`
peer**). The Postgres/Drizzle implementation of the seam ships separately as
`createDrizzleScopedKeyStore` in
`@octabits-io/framework/drizzle/scoped-key-store` (column
shapes per that package's `encryptionKeyColumns` + a consumer-declared,
**unique** scope column); provide your own store to back it with anything else.

```ts
import { createScopedKeyService } from '@octabits-io/framework/pii';
import { createDrizzleScopedKeyStore } from '@octabits-io/framework/drizzle/scoped-key-store';

const scope = { column: 'orgId', value: orgId };  // consumer-chosen scope column
// A multi-tenant consumer binds the scope to its own tenantId column instead:
// const scope = { column: 'tenantId', value: tenantId };

const store = createDrizzleScopedKeyStore({
  db,                             // structural Drizzle db (select/insert/delete)
  table: schema.orgEncryptionKey, // your encryption-key table
  scope,                          // same scope the service is bound to
});

const keyService = createScopedKeyService({
  store,
  scope,
  masterKeyProvider,
  cache,                          // e.g. LRU with ~5-minute TTL
});

const keys = await keyService.getKeys();     // lazy-generates on first use
// keys.value: { recipient, identity, blindIndexKey, keyVersion }

// Explicit generation inside the caller's transaction — re-bind the store to
// the tx so the write joins it. The cache is NOT pre-populated (the tx may
// still roll back); the next getKeys() populates it.
await db.transaction(async (tx) => {
  await keyService.generateKeyPair(store.withDb(tx));
});

await keyService.hasKeys();                  // Result<boolean, ScopedKeyError>
await keyService.destroyKeys();              // crypto-shredding: delete key row + drop cache
keyService.invalidateCache();
```

The store maps its failures to two neutral outcomes — a lost unique race
(`scoped_key_store_conflict`, drives concurrent-generation recovery) vs any
other failure (`scoped_key_store_failure`) — which the service translates to its
`Result`-typed public errors: `scoped_keys_not_found`,
`scoped_key_generation_error`, `scoped_key_storage_error`, or a master-key error
(`master_key_error` / `master_key_unsupported_plaintext`).

Cache entries are keyed by `column:value` (URI-encoded). Don't share one cache instance across services whose stores persist keys in different tables under the same scope column and value — use one cache per key store.

#### Low-Level Primitives

```ts
import { encryptHybrid, decryptHybrid } from '@octabits-io/framework/pii';
import { encryptSymmetric, decryptSymmetric, generateSymmetricKey } from '@octabits-io/framework/pii';

// Age encryption (X25519 + ChaCha20-Poly1305)
const encrypted = await encryptHybrid('plaintext', 'age1...');
const decrypted = await decryptHybrid(encrypted.value, 'AGE-SECRET-KEY-1...');

// AES-256-GCM symmetric encryption
const key = generateSymmetricKey();
const enc = encryptSymmetric('plaintext', key);
const dec = decryptSymmetric(enc.value, key);
```

### `@octabits-io/framework/drizzle/*`

(Formerly the standalone `@octabits-io/drizzle-toolkit` package.)
Shared Drizzle ORM utilities for PostgreSQL: database error handling, pagination,
a drizzle factory, a migration runner, generic CRUD service factories, a
scoped config store, RLS scoping, an idempotency-key store, a job-audit store,
and generic scope schema primitives.

`pg` is an **optional peer dependency** — only the `./factory` and `./migrate`
subpaths need it at runtime (`./rls` uses its types only). Install `pg` in your
app when you use those modules; every other subpath works without it.

#### `@octabits-io/framework/drizzle/db`

Database error handling and pagination helpers.

```ts
import {
  withDbErrorHandling,
  handleTransactionError,
  TransactionRollbackError,
  normalizePaginationLimit,
} from '@octabits-io/framework/drizzle/db';

// Wrap DB operations — catches PG errors and returns Result<T, E | OctDatabaseError>
const result = await withDbErrorHandling(async () => {
  await db.insert(users).values({ email });
  return { ok: true, value: undefined };
});
// result.error.code → 'unique_violation' | 'foreign_key_violation' | ...

// Inside transactions — preserve typed errors through rollback
try {
  await db.transaction(async (tx) => {
    const result = await paymentService.create(tenantId, params, tx);
    if (!result.ok) throw new TransactionRollbackError(result.error);
  });
} catch (error) {
  return handleTransactionError(error); // preserves typed error or maps PG error
}

// Pagination: limit=-1 → capped at 10,000
const dbLimit = normalizePaginationLimit(params.limit);
```

#### `@octabits-io/framework/drizzle/factory`

Drizzle instance factory over a pre-built `pg.Pool`, with schema augmentation
(`db.tables.*` / `db.schema.*`) and a `.transaction()` whose callback receives
an equally-augmented instance.

```ts
import { Pool } from 'pg';
import { createDrizzle } from '@octabits-io/framework/drizzle/factory';

const pool = new Pool({ connectionString, max: 20 });
const db = createDrizzle(schema, { pool }); // optional: logger
```

Also exported: `createDrizzleFromClient` (single `PoolClient` — for
request-scoped connections carrying session vars, e.g. RLS) and
`augmentDrizzle` (wrap an existing instance).

#### `@octabits-io/framework/drizzle/migrate`

Migration runner for Drizzle SQL migrations.

```ts
import { runMigrations } from '@octabits-io/framework/drizzle/migrate';

await runMigrations({ connectionString, migrationsFolder });
// optional: ssl, logger, sessionVars (GUCs set before migrate — e.g. RLS system mode)
```

#### `@octabits-io/framework/drizzle/scope`

Generic schema primitives for a **scope-owner** root plus per-scope keys and
config — **column-sets** for three common base tables. A "scope" is whatever
partitions your app (a tenant, workspace, organization, project, or nothing at
all when single-tenant); the scope-reference column is **yours to declare**.

| Column-set              | Purpose                                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `baseScopeColumns`      | The scope-owner root — generic columns only (`id`, `name`, `isDisabled`, `createdAt`). |
| `encryptionKeyColumns`  | Per-scope PII encryption material (Age recipient + encrypted identity + blind-index key). Pairs with `@octabits-io/framework/pii` — skip it if you don't use that package. |
| `scopedConfigColumns`   | Key/value config columns (`key`, `value` jsonb, `encrypted`, audit) — add your own scope column and a `(scopeColumn, key)` PK. |

Only `drizzle-orm/pg-core` primitives are used — no framework or app imports.

Spread a column-set into your own `pgTable(...)` (the documented Drizzle
["reuse common column definitions"](https://orm.drizzle.team/docs/sql-schema-declaration#advanced)
pattern) to extend the base with domain columns. The tables, constraints, and
relations stay in *your* schema — the module ships no `pgTable` instances, so
your migrations never depend on a library-defined table. The
`encryptionKeyColumns` / `scopedConfigColumns` sets deliberately omit the scope
column so you own its name, type, FK, and PK placement:

```ts
import { pgTable, text, integer, primaryKey } from "drizzle-orm/pg-core";
import { baseScopeColumns, scopedConfigColumns } from "@octabits-io/framework/drizzle/scope";

// Extend the scope-owner root with your domain columns (name it what you like):
export const tenant = pgTable("tenant", {
  ...baseScopeColumns, // id, name, isDisabled, createdAt
  region: text("region").notNull(),
  seatLimit: integer("seat_limit"),
});

// Add your scope column and declare the composite PK in the constraints callback:
export const tenantConfig = pgTable(
  "tenant_config",
  {
    ...scopedConfigColumns,
    tenantId: text("tenant_id").notNull(), // your scope column
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key], name: "tenant_config_pk" })],
);
```

Exports: `bytea` (custom `bytea ↔ Buffer` column type) and the three
column-sets (`baseScopeColumns`, `encryptionKeyColumns`, `scopedConfigColumns`).

#### `@octabits-io/framework/drizzle/crud`

Generic CRUD service factories over any Drizzle table with an `id` column —
paginated `list` (+total), `getById`, `create`, `update`, `delete`, with
consistent keyed errors and optional `created_by`/`updated_by` audit stamping:

- `createBaseCrudService` — no scoping.
- `createScopedCrudService` — every query auto-ANDed with
  `eq(table[scope.column], scope.value)`; `create()` injects the scope column.
  Row isolation holds by construction (`scope: { column, value }`) — bind
  whatever column partitions your app (`{ column: 'tenantId', value }`,
  `{ column: 'workspaceId', value }`, …).

#### `@octabits-io/framework/drizzle/scoped-key-store`

The Drizzle adapter behind `@octabits-io/framework/pii`'s structural
`ScopedKeyStore` seam. pii owns the encryption logic but knows nothing about
SQL — it depends on a four-method store (`insert` / `find` / `exists` /
`destroy`), scope-bound at construction — so it carries **no `drizzle-orm`
peer**. This module is the Postgres/Drizzle implementation of that seam (the ORM
query logic lives here, where Drizzle is already a hard dep).

- `createDrizzleScopedKeyStore({ db, table, scope })` — binds to one
  `{ column, value }` scope over an encryption-key table (spread
  `encryptionKeyColumns` from `./scope` + a **unique** scope column).
  `insert` stamps the scope column and maps a lost unique race (SQLSTATE 23505,
  walked through the driver/ORM `cause` chain) to `scoped_key_store_conflict`;
  `find` selects the four key fields for the scope (or `null`); `exists` /
  `destroy` are scoped by construction. `store.withDb(tx)` re-binds the same
  table + scope to a transaction so generation writes join the caller's tx.
- The row/error types are structural **duplicates** of pii's — no cross-package
  import (the same decoupling `./config`'s `ConfigCipher` uses). Wire it with
  `createScopedKeyService({ store, scope, masterKeyProvider, cache })`.

#### `@octabits-io/framework/drizzle/job-audit-store`

The Drizzle adapter behind `@octabits-io/framework/queue`'s structural
`onDlqAudit` sink. `defineQueue` hands each dead-lettered job to an injected
sink and bakes in **no table schema**, so queue carries no `drizzle-orm` peer;
this module is the Postgres/Drizzle implementation of that seam. Record types
are structural **duplicates** of queue's — no cross-module import.

- `jobAuditColumns` — spreadable column-set (`jobId`, `queueName`, `jobType`,
  `status`, `payload`, `errorMessage`, `attemptCount`, `createdAt`,
  `completedAt`). As with `./scope`'s sets, the **scope column is yours to
  declare** — omit it entirely in a single-scope deployment. `payload` uses
  `jsonbSafe` (a schema-invalid payload is an arbitrary `unknown`, so it can be
  a top-level JSON string — exactly what stock `jsonb()` silently retypes on
  read).
- `createDrizzleJobAuditStore({ db, table, scope? })` — `store.onDlqAudit` drops
  straight into `defineQueue({ onDlqAudit })`; `store.record(record)` is the
  `Result`-returning primitive underneath.

```ts
const auditStore = createDrizzleJobAuditStore({
  db,
  table: schema.jobAuditLog,
  scope: { column: 'tenantId' }, // value read per-record from record.scopeKey
});

export const emailQueue = defineQueue({
  name: 'email',
  schema: SCHEMA_EMAIL_PAYLOAD,
  createHandler,
  resolveScopeKey: (data) => data.tenantId, // populates record.scopeKey
  onDlqAudit: auditStore.onDlqAudit,
});
```

Scoping differs from `./scoped-key-store`'s fixed `{ column, value }` on
purpose: a key store serves one scope, but a queue definition is
process-global — dead-lettered jobs from *every* scope flow through the one
sink. So `value` is **optional** and defaults to each record's `scopeKey`:

| `scope` | Behaviour |
| --- | --- |
| omitted | No scope column stamped; every record written. |
| `{ column }` | Stamped from `record.scopeKey`. A record without one (system/cron queues, which omit `resolveScopeKey`) is **skipped** → `skipped_unscoped`. |
| `{ column, value }` | Fixed value stamped on every record; `record.scopeKey` ignored. |

The skip exists because such a column is typically FK-bound and `NOT NULL` — a
row a system job could not satisfy anyway. Nothing is lost silently:
`defineQueue` logs every dead-letter with full context *before* invoking the
sink, so those jobs are log-only. `record()` returns the outcome
(`recorded` | `skipped_unscoped`) so callers can tell a write from a skip;
`onDlqAudit` **throws** on a storage failure (the seam returns `void`, and a
swallowed error is a silently lost audit trail — `defineQueue` catches it, logs
`Failed to run DLQ audit sink`, and keeps the batch alive).

#### `@octabits-io/framework/drizzle/config`

Generic **config store** over any key/value table (spread
`scopedConfigColumns` from `./scope`): the validate → encrypt → cache →
default engine. Scoping is **optional**, mirroring `./crud`'s base-vs-scoped
split — no tenant vocabulary in the core.

- `createScopedConfigService` — `writeConfig` validates each `{ key, value }`
  through a caller-supplied `schema`, ciphers `encryptedKeys` into a
  `{ __encrypted: <base64> }` envelope, and upserts every entry in one
  statement; `readConfig(...keys)` / `readAll()` decrypt, re-validate (so **Zod
  defaults apply** for absent rows), and cache. Generic over the caller's
  key→value map. Pass a `{ column, value }` `scope` to partition rows (conflict
  target `(scopeColumn, key)`); **omit `scope`** for an unscoped single-tenant
  store (conflict target `(key)`). The conflict target must match the table's
  primary key.
- Encryption is an injected `cipher` (raw-string `encrypt`/`decrypt`) — no
  `@octabits-io/framework/pii` dependency; the engine owns the envelope + JSON. A
  `readConfig` on an undecryptable `encrypted=true` row **throws**
  `ScopedConfigDecryptError` rather than silently falling back to a default.
- `createScopedConfigCache` builds the optional cross-scope cache over a
  foundation `LruCache`, gated by `cacheableKeys` (transactional keys are never
  cached); `readConfig` also keeps a request-scoped cache, both invalidated on
  write.

#### `@octabits-io/framework/drizzle/rls`

Postgres row-level-security scoping, generic over the GUC key set:
`createScopedDb(rawDb, gucs)` (per-call-transaction proxy — every top-level
operation runs inside a short transaction that applies transaction-local
`set_config(name, value, true)` first; PgBouncer-safe), `runWithGucs`,
`withSystemMode`, the pinned-connection `acquireScopedClient` /
`releaseScopedClient`, and `endPoolGracefully`. Policies and concrete GUC
values stay in the consumer.

**`createGucScopeFactory({ container, dbKey?, enabled?, gucs, seed? })`** — the
bridge to `…/ioc` every RLS consumer otherwise hand-writes per scope kind
(request/system/grant scope): returns `(args) => scope` where the child scope's
`db` (or `dbKey`) is re-registered as a Scoped `createScopedDb` proxy over
`gucs(args)`, and `seed(scope, args)` adds per-scope registrations. With
`enabled: false` the raw db resolves through the parent chain but `seed` still
runs — same wiring against a database without RLS policies. The container is
addressed structurally (`ScopeContainer`/`ScopeChild`), so wrapped containers
work.

**List-valued GUCs** — single values are parameterized safely, but a list
joined into one GUC (split DB-side via `string_to_array(…, ',')`) has an
in-band separator: use `assertSafeGucListValue(values)` /
`joinGucList(values)`, which reject any element containing `,` or `'` instead
of silently widening the policy's match set.

#### `@octabits-io/framework/drizzle/idempotency`

Stripe-style `X-Idempotency-Key` store: `createIdempotencyService` —
`begin()` → cached / fresh (`.commit(status, body)`) / conflict, TTL expiry,
request-hash matching, race-safe unique-violation handling, opportunistic
cleanup. Scoping is optional (`scope?: { column, value }`); ships a spreadable
`idempotencyKeyColumns` column-set (add your own scope column when scoping).

> **Note:** `./scope` absorbed the former standalone `@octabits-io/schema`
> package. The former `./testing` module (testcontainers helpers, ex
> `@octabits-io/drizzle-test`) was removed — it had no consumers; copy it from
> git history if you need it.
> The former `./workflow` module (DAG workflow engine) has been superseded by
> [`@octabits-io/flow`](../flow) — a standalone durable workflow engine with a
> Postgres store and pg-boss dispatcher. Use that package instead.

### `@octabits-io/framework/ical`

(Formerly the standalone `@octabits-io/ical` package.)
iCal ingestion in two independent pieces: a **fetcher** that pulls a calendar
over http(s)/`webcal` with a timeout, a size cap, and a change-detection hash;
and a **parser** that expands VEVENTs/RRULEs into raw event ranges, with an
optional day-blocking collapse layer on top. Both are domain-free — no booking
or rental vocabulary in the base API.

`@octabits-io/framework` (`Result`, `OctError`, `Logger`) and `ical.js` (v2)
are peer dependencies. Errors are foundation `Result`/`OctError` values (never
thrown); every error `key` is `ical_*`.

#### Fetcher

```ts
import { createICalFetcherService } from '@octabits-io/framework/ical';

const fetcher = createICalFetcherService({
  logger,
  // all optional:
  fetch: myPinnedFetch,        // default globalThis.fetch
  timeoutMs: 30_000,           // default 30s
  maxResponseBytes: 5_242_880, // default 5 MB
  allowPrivateNetwork: false,  // default false
});

const result = await fetcher.fetch('webcal://example.com/cal.ics', previousHash);
if (!result.ok) {
  // result.error.key: 'ical_fetch_failed' | 'ical_fetch_timeout' | 'ical_too_large' | …
  return;
}
const { data, hash, hasChanged } = result.value;
```

- `webcal://` is rewritten to `https://`; after that only `http:`/`https:`
  schemes are accepted — everything else (e.g. `file:`) is rejected.
- URLs whose hostname is a **literal** private, loopback, or link-local IP
  (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, `::1`, `fc00::/7`,
  `fe80::/10`, IPv4-mapped forms) are rejected unless `allowPrivateNetwork:
  true` is set.
- **SSRF note:** the private-IP check only sees literal IPs. It cannot see
  what a DNS name resolves to (DNS rebinding), and redirects are followed for
  feed portability — a public URL may redirect to a private address. If you
  need DNS-rebinding or redirect-to-private protection, inject a `fetch`
  bound to a safe dispatcher (e.g. an undici Agent with a filtering
  `lookup`/`connect`).
- Configurable timeout (default 30 s) via `AbortController` — it covers both
  headers and body download.
- Response cap (default 5 MB) counted in **bytes**: rejected early from
  `Content-Length` when present, and enforced again while streaming the body —
  the download is aborted as soon as the cap is exceeded, never buffered in
  full.
- `DTSTAMP` lines (including RFC 5545 folded continuation lines) are stripped
  before hashing — calendar servers regenerate them on every export, so
  keeping them would make every fetch look like a change.
- Userinfo (`user:pass@`) is redacted from URLs before they appear in error
  messages or log metadata.
- The hash is a fast **non-cryptographic** cyrb53 digest, used only for change
  detection. Pass the previous hash to get `hasChanged`; pass `null`/omit to
  always report changed.

| Error key | When |
| --- | --- |
| `ical_url_invalid` | Unparsable URL, or a scheme other than http(s)/webcal. |
| `ical_url_private_network` | Literal private/loopback/link-local IP hostname (without `allowPrivateNetwork`). |
| `ical_fetch_failed` | Non-2xx response (carries `status`). |
| `ical_fetch_timeout` | Request exceeded the timeout (default 30 s). |
| `ical_too_large` | Response exceeded the byte cap (default 5 MB). |
| _(passthrough)_ | Network/other failures map through `toOctError`. |

#### Parser

##### Base API — raw event ranges

`parseEventRanges` returns each VEVENT occurrence as-is: inclusive `start`,
**exclusive** `end` (per iCal DTEND semantics), `summary`, `uid`, and an
`allDay` flag. RRULEs are expanded, capped at 5000 occurrences per event to
guard against pathological rules (e.g. `FREQ=SECONDLY`).

```ts
import { createICalParserService } from '@octabits-io/framework/ical';

const parser = createICalParserService();

const ranges = parser.parseEventRanges(icalData, {
  windowStart: new Date('2025-03-01'),
  windowEnd: new Date('2025-03-31'), // bounds RRULE expansion
});
if (!ranges.ok) return;
for (const r of ranges.value) {
  // { start: Date, end: Date, summary: string, uid: string, allDay: boolean }
}
```

`windowEnd` bounds recurrence expansion and is strongly recommended for
recurring feeds. `windowStart` drops occurrences that already ended — those
pre-window occurrences do **not** count against the occurrence cap, so a
DTSTART years in the past still yields the current window (a separate internal
runaway guard bounds the skipping). `maxOccurrencesPerEvent` (default 5000)
overrides the safety cap.

**Timezone caveat:** ical.js bundles no IANA timezone data. `TZID` references
are only honoured when the feed ships a matching `VTIMEZONE`; otherwise the
timestamps are interpreted in the **server's own zone**. Absolute instants
(`start`/`end`) are therefore only reliable for UTC/floating times or feeds
that include their `VTIMEZONE`s — the `startWallClock`/`endWallClock`
components are always the event's own wall-clock reading and are safe
regardless.

##### Optional layer — day-blocking collapse

`collapseToBlockedDateRanges` is the opinionated layer on top: it collapses
events into blocked **calendar-day** ranges (`YYYY-MM-DD`, both ends inclusive)
within a window. All-day events map to their date span (exclusive DTEND, so the
last day is dropped); timed events are collapsed to whole days via an
`hourThreshold` heuristic (default `12`) — a timed event starting before the
threshold also blocks the previous day, and one ending before it stops on the
previous day. Non-overlapping ranges are filtered out.

```ts
const blocked = parser.collapseToBlockedDateRanges(
  icalData,
  new Date('2025-03-01'),
  new Date('2025-03-31'),
  { hourThreshold: 12 }, // optional
);
if (!blocked.ok) return;
// blocked.value: [{ start: '2025-03-09', end: '2025-03-10', summary: '…' }, …]
```

The heuristic mirrors check-in/check-out style day blocking. Consumers that want
raw ranges (or a different collapse) build on `parseEventRanges` instead.
