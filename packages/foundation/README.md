# @octabits-io/foundation

Shared foundation library providing core primitives used across the platform: error handling, dependency injection, structured logging, common utilities, Zod config fragments, an RBAC engine, and OIDC/JWT validation.

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
