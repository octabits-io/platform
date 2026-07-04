# @octabits-io/elysia

Reusable [Elysia](https://elysiajs.com) middleware and helpers, extracted from
production APIs. Domain-agnostic — errors are
[`@octabits-io/foundation`](../foundation)'s `OctError` (`{ key, message }`;
`KeyedError` is kept as an alias), the error handler takes foundation's
`Logger`, and any domain-specific key→status rules are injected via
`statusOverrides`. Foundation is a **peer dependency** — this package is part
of the octabits stack, not a standalone kit.

## Contents

- **`createSecurityHeadersPlugin(options?)`** — sets standard hardening response
  headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `X-XSS-Protection`, CSP, and HSTS in production). Configurable `csp` / `hsts`.
- **`createClientIpPlugin(trustedProxies)`** — derives `clientIp` from
  `X-Forwarded-For` only when the direct connection is a trusted proxy (`'*'`,
  an IP allowlist, or `[]` for none). Used to key rate limiting.
- **Error mapping** — `getStatusCodeForError`, `statusErrorWithSet`,
  `mapResultError`, the `ApiError` class family (`NotFoundError`,
  `ForbiddenError`, …), `isDbConnectionError`, and the `createErrorHandler`
  global plugin.
- **Response schemas** — `SCHEMA_ERROR_RESPONSE`, `SCHEMA_VALIDATION_ERROR`,
  `SCHEMA_SUCCESS_RESPONSE`, the `CommonErrorResponses` superset, and the
  `errorResponses(...codes)` selector.

## Usage

```ts
import { Elysia } from 'elysia';
import {
  createSecurityHeadersPlugin,
  createClientIpPlugin,
  createErrorHandler,
  statusErrorWithSet,
  CommonErrorResponses,
} from '@octabits-io/elysia';

const app = new Elysia()
  .use(createSecurityHeadersPlugin())
  .use(createClientIpPlugin(['*']))
  .use(createErrorHandler(logger));

// In a route, translate a Result error to an HTTP response:
if (!result.ok) return statusErrorWithSet(set, result.error, { tenant_not_found: 403 });
```

Peer dependencies: `elysia`, `zod`.
