/**
 * Error mapping for Elysia APIs: key-convention → HTTP status, the
 * `statusErrorWithSet` route helper, the `ApiError` class family,
 * DB-connection detection, and the `createErrorHandler` global plugin.
 *
 * Errors are foundation's `OctError` (`{ key, message }`). Domain-specific
 * key→status rules (e.g. `tenant_not_found → 403`) are supplied via
 * `statusOverrides`.
 */
import { Elysia } from 'elysia';
import type { OctError } from '../result/index.ts';
import type { Logger } from '../logger/index.ts';
import { isProduction } from './config';

/**
 * A domain error carrying a stable `key` and a `message`.
 * Alias of foundation's `OctError` — kept as the historical elysia-local name.
 */
export type KeyedError = OctError;

/** Per-key HTTP status overrides, checked before the generic key conventions. */
export type ErrorStatusOverrides = Record<string, number>;

/**
 * Map a keyed error to an HTTP status by key convention:
 * - `*_not_found` / `not_found` → 404
 * - `unauthorized` / `invalid_token` → 401
 * - `forbidden` / `permission_denied` → 403
 * - `invalid_*` / `validation_*` → 400
 * - `missing_*` / `incomplete_*` / `*_not_configured` → 422
 * - everything else → 500
 *
 * `overrides` (e.g. `{ tenant_not_found: 403 }`) win over the conventions.
 */
export function getStatusCodeForError(error: KeyedError, overrides?: ErrorStatusOverrides): number {
  const key = error.key;

  if (overrides && key in overrides) return overrides[key]!;

  if (key.endsWith('_not_found') || key === 'not_found') return 404;
  if (key === 'unauthorized' || key === 'invalid_token') return 401;
  if (key === 'forbidden' || key === 'permission_denied') return 403;
  if (key.startsWith('invalid_') || key.startsWith('validation_')) return 400;
  if (key.startsWith('missing_') || key.startsWith('incomplete_') || key.endsWith('_not_configured')) return 422;

  return 500;
}

/** Elysia `context.set` — only the part we mutate. */
interface ElysiaSet {
  status?: number | string;
}

/** The response body shape emitted by {@link statusErrorWithSet}. */
export interface ErrorResponseBody {
  key: string;
  message: string;
  /** Field-level details (validation errors). */
  fields?: Array<{ path: string; message: string }>;
}

/**
 * Convert a keyed error into an error response body and set the status on `set`.
 *
 * Only the documented response fields (`key`, `message`, and `fields` when
 * present) are serialized — any other enumerable properties on the error are
 * never sent to the client. When the error maps to a 5xx status and the
 * process runs in production (see `isProduction()`), the message is redacted
 * to a generic `'Internal error'`; the key is kept.
 *
 * @example
 * const result = await service.getData();
 * if (!result.ok) return statusErrorWithSet(set, result.error);
 */
export function statusErrorWithSet<E extends KeyedError>(
  set: ElysiaSet,
  err: E,
  overrides?: ErrorStatusOverrides,
): ErrorResponseBody {
  const status = getStatusCodeForError(err, overrides);
  set.status = status;
  const message = status >= 500 && isProduction() ? 'Internal error' : err.message;
  const fields = (err as { fields?: ErrorResponseBody['fields'] }).fields;
  return fields !== undefined
    ? { key: err.key, message, fields }
    : { key: err.key, message };
}

/** API error carrying an HTTP status code and a stable error key. */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public key: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, key = 'not_found') {
    super(404, key, message);
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string, key = 'bad_request') {
    super(400, key, message);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized', key = 'unauthorized') {
    super(401, key, message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden', key = 'forbidden') {
    super(403, key, message);
  }
}

export class UnprocessableEntityError extends ApiError {
  constructor(message: string, key = 'unprocessable_entity') {
    super(422, key, message);
  }
}

export class TooManyRequestsError extends ApiError {
  constructor(message = 'Too Many Requests', key = 'too_many_requests') {
    super(429, key, message);
  }
}

export class InternalServerError extends ApiError {
  constructor(message = 'Internal Server Error', key = 'internal_server_error') {
    super(500, key, message);
  }
}

/** Map a keyed error to the appropriate `ApiError` subclass (respecting `overrides`). */
export function mapResultError(error: KeyedError, overrides?: ErrorStatusOverrides): ApiError {
  const status = getStatusCodeForError(error, overrides);
  switch (status) {
    case 404: return new NotFoundError(error.message, error.key);
    case 401: return new UnauthorizedError(error.message, error.key);
    case 403: return new ForbiddenError(error.message, error.key);
    case 400: return new BadRequestError(error.message, error.key);
    case 422: return new UnprocessableEntityError(error.message, error.key);
    case 429: return new TooManyRequestsError(error.message, error.key);
    default: return new InternalServerError(error.message, error.key);
  }
}

const DB_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
]);

const DB_CONNECTION_PG_CODES = new Set([
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
]);

const DB_CONNECTION_MESSAGE_PATTERNS = [
  'timeout exceeded when trying to connect',
  'Cannot use a pool after calling end on the pool',
  'Connection terminated unexpectedly',
] as const;

/**
 * Detect PostgreSQL / pg-pool connection errors by inspecting error codes,
 * PG error classes (`08xxx`), message strings, and the `cause` chain.
 */
export function isDbConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const err = error as Error & { code?: string; cause?: unknown };

  // Node.js system error codes (ECONNREFUSED, etc.).
  if (err.code && DB_CONNECTION_ERROR_CODES.has(err.code)) return true;

  // PostgreSQL connection-exception class 08xxx or specific codes.
  if (err.code && (err.code.startsWith('08') || DB_CONNECTION_PG_CODES.has(err.code))) return true;

  // pg-pool message patterns.
  if (DB_CONNECTION_MESSAGE_PATTERNS.some((pattern) => err.message.includes(pattern))) return true;

  // Recurse into the cause chain.
  if (err.cause) return isDbConnectionError(err.cause);

  return false;
}

/** Elysia validation-error shape (for extracting field errors). */
interface ElysiaValidationError extends Error {
  all?: Array<{ path?: string; message?: string }>;
  property?: string;
}

export interface ErrorHandlerOptions {
  /** Whether to hide internal error messages from clients. Defaults to this package's `isProduction()` (`NODE_ENV === 'production'` OR `PRODUCTION` truthy). */
  production?: boolean;
}

/**
 * Global Elysia error-handling plugin. Maps framework validation/not-found errors,
 * `ApiError` instances, and DB-connection failures (→ 503) to the standard
 * `{ key, message[, fields] }` body. In production, unexpected error messages are
 * not exposed to clients.
 */
export const createErrorHandler = (logger: Logger, options: ErrorHandlerOptions = {}) => {
  const production = options.production ?? isProduction();

  return new Elysia({ name: 'error-handler' })
    .onError({ as: 'global' }, ({ error, code, set }) => {
      // Elysia validation errors.
      if (code === 'VALIDATION') {
        set.status = 400;

        const validationError = error as ElysiaValidationError;
        const fields: Array<{ path: string; message: string }> = [];

        if (validationError.all) {
          for (const err of validationError.all) {
            fields.push({
              path: err.path?.replace(/^\//, '') || 'unknown',
              message: err.message || 'Invalid value',
            });
          }
        } else if (validationError.property) {
          fields.push({
            path: validationError.property.replace(/^\//, ''),
            message: (error as Error).message,
          });
        }

        return { key: 'validation_error' as const, message: 'Validation failed', fields };
      }

      if (code === 'NOT_FOUND') {
        set.status = 404;
        return { key: 'not_found' as const, message: 'Route not found' };
      }

      if (error instanceof ApiError) {
        set.status = error.statusCode;
        // 5xx messages may carry internals (e.g. an unknown-key OctError mapped
        // via mapResultError) — redact in production, keep the stable key.
        const message = error.statusCode >= 500 && production ? 'Internal error' : error.message;
        return { key: error.key, message };
      }

      // Database connection errors → 503 Service Unavailable.
      if (isDbConnectionError(error)) {
        logger.error('Database connection error', error instanceof Error ? error : new Error(String(error)));
        set.status = 503;
        return { key: 'service_unavailable', message: 'Service temporarily unavailable' };
      }

      logger.error('Unhandled error', error instanceof Error ? error : new Error(String(error)));

      set.status = 500;
      return {
        key: 'internal_server_error',
        message: production ? 'Internal Server Error' : (error instanceof Error ? error.message : 'Internal Server Error'),
      };
    });
};
