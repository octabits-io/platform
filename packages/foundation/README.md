# @octabits-io/foundation

Shared foundation library providing core primitives used across the platform: error handling, dependency injection, structured logging, common utilities, Zod config fragments, an RBAC engine, OIDC/JWT validation, and per-scope signing.

## Modules

### `@octabits-io/foundation/result`

Type-safe error handling using the Result pattern — no thrown exceptions.

```ts
import type { Result, OctError } from '@octabits-io/foundation/result';
import { ok, err, tryCatch, tryCatchAsync, isOctError, toOctError } from '@octabits-io/foundation/result';

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

### `@octabits-io/foundation/ioc`

Lightweight IoC container with singleton, scoped, and transient lifetimes.

```ts
import { IoC, ServiceLifetime } from '@octabits-io/foundation/ioc';

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

**Key types:** `ServiceResolver<T>`, `DisposableServiceResolver<T>`, `SystemScopeFactory<T>`

---

### `@octabits-io/foundation/logger`

Structured logging with OpenTelemetry-compatible output.

```ts
import { createLoggerService } from '@octabits-io/foundation/logger';

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

### `@octabits-io/foundation/utils`

Common utility functions.

```ts
import { slugify, isUrlFriendly } from '@octabits-io/foundation/utils';
import { tryDecodeBase64 } from '@octabits-io/foundation/utils';
import { normalizeQueryParamToStringOrUndefined } from '@octabits-io/foundation/utils';

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

---

### `@octabits-io/foundation/config-schema`

Reusable Zod config fragments — compose them into your app's config schema.

```ts
import {
  nonEmptyString,
  nonEmptyUrl,
  DATABASE_CONFIG_SCHEMA,
  createRlsSchema,
  LOGGING_CONFIG_SCHEMA,
} from '@octabits-io/foundation/config-schema';

const CONFIG_SCHEMA = z.object({
  database: DATABASE_CONFIG_SCHEMA,
  rls: createRlsSchema(true), // default-enabled RLS toggle
  logging: LOGGING_CONFIG_SCHEMA,
  apiUrl: nonEmptyUrl(),
});
```

---

### `@octabits-io/foundation/rbac`

Self-contained, dependency-free RBAC engine: pure resource/action subset
checking, generic over a caller-supplied permission statement. The concrete
statement matrix and named roles live in the consuming application.

```ts
import { createRole, checkLocalPermission } from '@octabits-io/foundation/rbac';

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

### `@octabits-io/foundation/auth`

Generic OIDC/JWT validation (optional peer: `jose`). Lazily discovers the JWKS
URI from the issuer's OIDC discovery document, verifies signatures via
`createRemoteJWKSet` (cached, rotation-aware), and hands verified payloads to a
caller-supplied `claimMapper` that produces your domain token shape.

```ts
import { createJwtValidationService } from '@octabits-io/foundation/auth';

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
import { createApiKeyFormat } from '@octabits-io/foundation/auth';

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
import { createBearerAuthService } from '@octabits-io/foundation/auth';

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

### `@octabits-io/foundation/signing`

Generic per-scope, per-purpose signing (optional peer: `jose`, loaded lazily and
only for the JWT primitives). One service for HMAC/JWT crypto, HKDF key
derivation, and constant-time comparison — so no consumer re-rolls its own. The
`scopeKey` is an opaque string feeding HKDF domain separation (not a DB column);
each `purpose` gets its own 256-bit key. Keys live behind an injected `keyStore`.

```ts
import { createScopedSigningService } from '@octabits-io/foundation/signing';

const signing = createScopedSigningService({
  infoPrefix: 'acme',                 // → HKDF info `acme-<purpose>-signing-key-v1`
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
