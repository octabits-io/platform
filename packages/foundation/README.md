# @octabits-io/foundation

Shared foundation library providing core primitives used across the platform: error handling, dependency injection, structured logging, and common utilities.

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
