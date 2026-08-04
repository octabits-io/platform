/**
 * SPIKE (elysia-exit-option): Hono wiring for the framework-neutral error
 * core (`resolveErrorResponse` from `../elysia/errors` — the function itself
 * has no Elysia dependency; a real port would move it to a neutral module).
 *
 * Differences from the Elysia handler this replaces:
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
import type { Hono } from 'hono';
import type { Env, ValidationTargets } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import type { Logger } from '../logger/index.ts';
import { isProduction } from '../server/config';
import { resolveErrorResponse, type ErrorHandlerOptions } from '../elysia/errors';

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
export function registerErrorHandler<E extends Env>(
  app: Hono<E>,
  logger: Logger,
  options: ErrorHandlerOptions = {},
): Hono<E> {
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
