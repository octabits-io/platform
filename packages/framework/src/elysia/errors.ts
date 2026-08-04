/**
 * Elysia glue for the framework-neutral error core (`../server/errors`): the
 * `createErrorHandler` global plugin. Everything else — the key-convention
 * status mapping, `statusErrorWithSet`, the `ApiError` family, DB-connection
 * detection, and `resolveErrorResponse` — lives in the base tier and is
 * re-exported here for backwards compatibility.
 */
import { Elysia } from 'elysia';
import type { Logger } from '../logger/index.ts';
import { isProduction } from '../server/config';
import { resolveErrorResponse, type ErrorHandlerOptions } from '../server/errors';

export * from '../server/errors';

/**
 * Global Elysia error-handling plugin. Maps framework validation/not-found errors,
 * `ApiError` instances, and DB-connection failures (→ 503) to the standard
 * `{ key, message[, fields] }` body. In production, unexpected error messages are
 * not exposed to clients. The classification itself lives in the framework-neutral
 * `resolveErrorResponse`; this plugin only adapts it to Elysia's `onError`.
 */
export const createErrorHandler = (logger: Logger, options: ErrorHandlerOptions = {}) => {
  const production = options.production ?? isProduction();

  return new Elysia({ name: 'error-handler' })
    .onError({ as: 'global' }, ({ error, code, set }) => {
      const resolved = resolveErrorResponse(error, { code, production, logger });
      if (resolved.kind === 'response') return resolved.response;
      set.status = resolved.status;
      return resolved.body;
    });
};
