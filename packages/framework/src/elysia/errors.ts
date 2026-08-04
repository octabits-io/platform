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
import { isProduction } from '../server/config';

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
 * - `already_*` / `*_conflict` → 409
 * - `rate_limit_exceeded` / `*_rate_limited` → 429
 * - `*_invalid_status` → 409
 * - everything else → 500
 *
 * The rules are checked in the order listed above, so an earlier, more specific
 * convention wins: `invalid_state_conflict` is a 400 (`invalid_*`), not a 409.
 * New conventions are appended for exactly that reason — they can never change
 * a status an existing rule already assigned.
 *
 * There is deliberately **no 423 convention**: no key shape reliably means
 * "locked" (`*_disabled` covers both a locked resource and an unconfigured
 * feature), so 423 stays an explicit `ApiError(423, …)` or a `statusOverrides`
 * entry.
 *
 * `overrides` (e.g. `{ tenant_not_found: 403 }`) win over every convention.
 */
export function getStatusCodeForError(error: KeyedError, overrides?: ErrorStatusOverrides): number {
  const key = error.key;

  if (overrides && key in overrides) return overrides[key]!;

  if (key.endsWith('_not_found') || key === 'not_found') return 404;
  if (key === 'unauthorized' || key === 'invalid_token') return 401;
  if (key === 'forbidden' || key === 'permission_denied') return 403;
  if (key.startsWith('invalid_') || key.startsWith('validation_')) return 400;
  if (key.startsWith('missing_') || key.startsWith('incomplete_') || key.endsWith('_not_configured')) return 422;
  if (key.startsWith('already_') || key.endsWith('_conflict')) return 409;
  if (key === 'rate_limit_exceeded' || key.endsWith('_rate_limited')) return 429;
  // "Entity is in status X, expected Y" — a conflict with current state, not a
  // server fault. Appended last so it can't re-map keys an earlier rule already
  // caught (`invalid_*` keys with the prefix stay 400).
  if (key.endsWith('_invalid_status')) return 409;

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

export class ConflictError extends ApiError {
  constructor(message: string, key = 'conflict') {
    super(409, key, message);
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
    case 409: return new ConflictError(error.message, error.key);
    case 422: return new UnprocessableEntityError(error.message, error.key);
    case 429: return new TooManyRequestsError(error.message, error.key);
    default: return new InternalServerError(error.message, error.key);
  }
}

/**
 * Bind a set of `statusOverrides` once and get the three override-sensitive
 * mappers back pre-applied — the wrapper every API otherwise rewrites by hand
 * around its own domain key→status table.
 *
 * ```ts
 * // errors.ts in a consumer:
 * export * from '@octabits-io/framework/elysia';
 * export const { getStatusCodeForError, statusErrorWithSet, mapResultError } =
 *   createErrorMapper({ attachment_blocked: 403, fill_already_running: 409 });
 * ```
 *
 * Re-exporting the bound trio *after* the `export *` shadows the unbound
 * originals, so route code keeps calling `statusErrorWithSet(set, err)` with no
 * overrides argument and cannot forget the domain rules.
 */
export function createErrorMapper(overrides?: ErrorStatusOverrides) {
  return {
    getStatusCodeForError: (error: KeyedError): number => getStatusCodeForError(error, overrides),
    statusErrorWithSet: <E extends KeyedError>(set: ElysiaSet, err: E): ErrorResponseBody =>
      statusErrorWithSet(set, err, overrides),
    mapResultError: (error: KeyedError): ApiError => mapResultError(error, overrides),
  };
}

/** The pre-bound mapper trio returned by {@link createErrorMapper}. */
export type ErrorMapper = ReturnType<typeof createErrorMapper>;

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

/** Framework validation-error shape (structural — matches Elysia's). */
interface ValidationErrorLike extends Error {
  all?: Array<{ path?: string; message?: string }>;
  property?: string;
}

export interface ErrorHandlerOptions {
  /** Whether to hide internal error messages from clients. Defaults to this package's `isProduction()` (`NODE_ENV === 'production'` OR `PRODUCTION` truthy). */
  production?: boolean;
}

/** What {@link resolveErrorResponse} decided: a full Response to pass through verbatim, or a status + body to emit. */
export type ResolvedErrorResponse =
  | { kind: 'response'; response: Response }
  | { kind: 'body'; status: number; body: ErrorResponseBody };

export interface ResolveErrorResponseOptions {
  /**
   * The framework's error-code discriminator, when it has one. `'VALIDATION'`
   * (schema failure, structural `{ all?, property? }` field shape) and
   * `'NOT_FOUND'` (route miss) are recognized; anything else is ignored.
   * (Elysia's `code` union includes numbers — those fall through to the
   * generic classification.)
   */
  code?: string | number;
  /** Redact 5xx messages. Callers usually pass a boot-time `isProduction()`. */
  production: boolean;
  /** 5xx and unexpected errors are logged here — redaction makes the client response useless for diagnosis, so this is the only record. */
  logger: Logger;
}

/**
 * The framework-neutral core of the global error handler: classify a thrown
 * value into `{ status, body }` (or a verbatim `Response` pass-through), with
 * production redaction and 5xx logging. `createErrorHandler` wires this into
 * Elysia's `onError`; a different HTTP framework would wire the same function
 * into its own error hook.
 */
export function resolveErrorResponse(error: unknown, options: ResolveErrorResponseOptions): ResolvedErrorResponse {
  const { code, production, logger } = options;

  // A thrown Response is an explicit, fully-formed answer — the only way to
  // short-circuit from a `resolve` hook, which cannot do so by returning
  // (see createBearerAuthPlugin's onUnauthorized). Pass it through verbatim
  // instead of reporting it as an unhandled error (which would 500 it).
  if (error instanceof Response) return { kind: 'response', response: error };

  // Schema-validation errors.
  if (code === 'VALIDATION') {
    const validationError = error as ValidationErrorLike;
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

    return { kind: 'body', status: 400, body: { key: 'validation_error', message: 'Validation failed', fields } };
  }

  if (code === 'NOT_FOUND') {
    return { kind: 'body', status: 404, body: { key: 'not_found', message: 'Route not found' } };
  }

  if (error instanceof ApiError) {
    // 5xx messages may carry internals (e.g. an unknown-key OctError mapped
    // via mapResultError) — redact in production, keep the stable key. The
    // redaction makes the client response useless for diagnosis, so the
    // full error must be logged here or it is lost entirely.
    if (error.statusCode >= 500) {
      logger.error(`Domain error mapped to ${error.statusCode} (key: ${error.key})`, error);
    }
    const message = error.statusCode >= 500 && production ? 'Internal error' : error.message;
    return { kind: 'body', status: error.statusCode, body: { key: error.key, message } };
  }

  // Database connection errors → 503 Service Unavailable.
  if (isDbConnectionError(error)) {
    logger.error('Database connection error', error instanceof Error ? error : new Error(String(error)));
    return { kind: 'body', status: 503, body: { key: 'service_unavailable', message: 'Service temporarily unavailable' } };
  }

  logger.error('Unhandled error', error instanceof Error ? error : new Error(String(error)));

  return {
    kind: 'body',
    status: 500,
    body: {
      key: 'internal_server_error',
      message: production ? 'Internal Server Error' : (error instanceof Error ? error.message : 'Internal Server Error'),
    },
  };
}

/**
 * Global Elysia error-handling plugin. Maps framework validation/not-found errors,
 * `ApiError` instances, and DB-connection failures (→ 503) to the standard
 * `{ key, message[, fields] }` body. In production, unexpected error messages are
 * not exposed to clients. The classification itself lives in the framework-neutral
 * {@link resolveErrorResponse}; this plugin only adapts it to Elysia's `onError`.
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
