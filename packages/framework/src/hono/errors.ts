/**
 * Hono wiring for the framework-neutral error core (`resolveErrorResponse`
 * from `../server/errors`).
 *
 * Differences from the Elysia handler this parallels:
 *
 * - **Validation**: Elysia surfaces schema failures as `code: 'VALIDATION'`
 *   with an undocumented error shape. Hono's `@hono/zod-validator` responds
 *   400 from the middleware by default — {@link octValidator} instead throws a
 *   {@link RequestValidationError} whose `.all` matches the structural
 *   `ValidationErrorLike` shape, so `resolveErrorResponse`'s VALIDATION branch
 *   runs UNCHANGED and emits the standard
 *   `{ key: 'validation_error', message, fields }` body.
 * - **Thrown `Response`**: Hono rethrows non-`Error` values past `onError`, so
 *   a raw thrown `Response` is NOT supported. The escape hatch for "answer
 *   with this exact response from deep inside" is Hono's own
 *   `HTTPException(status, { res })`, which IS an `Error` and is passed
 *   through verbatim here. (`resolveErrorResponse`'s Response-passthrough
 *   branch also still works for any caller that hands us a `Response`.)
 */
import type { Context, Hono } from 'hono';
import type { ValidationTargets } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ClientErrorStatusCode, ServerErrorStatusCode } from 'hono/utils/http-status';
import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import type { Logger } from '../logger/index.ts';
import { isProduction } from '../server/config';
import {
  createErrorMapper,
  resolveErrorResponse,
  type ErrorHandlerOptions,
  type ErrorStatusOverrides,
  type KeyedError,
} from '../server/errors';

/**
 * Schema-validation failure carrying the structural `ValidationErrorLike`
 * shape (`.all`), so the shared `resolveErrorResponse` classifies it exactly
 * like an Elysia `code: 'VALIDATION'` error.
 */
export class RequestValidationError extends Error {
  constructor(public all: Array<{ path?: string; message?: string }>) {
    super('Validation failed');
    this.name = 'RequestValidationError';
  }
}

/**
 * `zValidator` with the framework's error contract: on failure, throw a
 * {@link RequestValidationError} for the global error handler instead of
 * answering 400 with zod's raw flattened output.
 */
export function octValidator<Target extends keyof ValidationTargets, S extends ZodType>(
  target: Target,
  schema: S,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new RequestValidationError(
        result.error.issues.map((issue) => ({
          path: issue.path.map(String).join('/'),
          message: issue.message,
        })),
      );
    }
  });
}

/**
 * Register the global error handler: `HTTPException` passes through verbatim,
 * everything else goes to the shared `resolveErrorResponse` core
 * (`ApiError` → status+body, DB-connection errors → 503, validation → 400
 * with fields, production redaction for 5xx).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerErrorHandler<T extends Hono<any, any, any>>(
  app: T,
  logger: Logger,
  options: ErrorHandlerOptions = {},
): T {
  const production = options.production ?? isProduction();

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();

    const code = error instanceof RequestValidationError ? 'VALIDATION' : undefined;
    const resolved = resolveErrorResponse(error, { code, production, logger });
    if (resolved.kind === 'response') return resolved.response;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(resolved.body, resolved.status as any);
  });

  return app;
}

/**
 * Build the keyed-error → JSON-response helper every route file needs:
 * `if (!result.ok) return errorJson(c, result.error)`. Wraps the
 * framework-neutral `createErrorMapper` (key conventions + production
 * redaction), bound once to a domain's `statusOverrides`.
 *
 * **Returning** the response rather than throwing an `ApiError` is deliberate:
 * the error shapes then stay in the route's inferred type, which is what makes
 * them visible to `hc` on the client side. Throwing works too (the global
 * error handler formats it identically) but erases the error body from the
 * route type.
 *
 * The status is asserted as non-2xx — what the key conventions actually
 * produce. `hc` narrows a route's response union on `res.status`/`res.ok`, and
 * a status type that still admitted `200` would stop `if (res.ok)` from
 * isolating the success body. (A consumer mapping a key to a 2xx via
 * `statusOverrides` would mislabel the type — but that is not an error
 * response.)
 */
export function createErrorJson(overrides?: ErrorStatusOverrides) {
  const { statusErrorWithSet } = createErrorMapper(overrides);

  return function errorJson(c: Context, error: KeyedError) {
    const set: { status?: number | string } = {};
    const body = statusErrorWithSet(set, error);
    return c.json(body, set.status as ClientErrorStatusCode | ServerErrorStatusCode);
  };
}

/** The unbound helper — the framework's key conventions with no domain overrides. */
export const errorJson = createErrorJson();
