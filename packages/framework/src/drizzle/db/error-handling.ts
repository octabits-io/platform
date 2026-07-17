import { type Result, type OctError, err } from '../../result/index.ts';
import type { PostgresErrorCode, OctDatabaseError } from './errors.ts';

/**
 * Error class for typed errors that should trigger transaction rollback
 * but preserve error type information for the caller.
 *
 * Use this inside db.transaction() when a nested service call returns an error
 * and you need to rollback but want to preserve the typed error.
 *
 * @example
 * ```ts
 * await db.transaction(async (tx) => {
 *   const result = await orderService.create(params, tx);
 *   if (!result.ok) {
 *     throw new TransactionRollbackError(result.error);
 *   }
 * });
 * ```
 */
export class TransactionRollbackError<E extends OctError> extends Error {
  constructor(public readonly typedError: E) {
    super(typedError.message);
    this.name = 'TransactionRollbackError';
  }
}

/**
 * Maps PostgreSQL error codes to semantic names.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const PG_ERROR_CODE_MAP: Record<string, PostgresErrorCode> = {
  '23505': 'unique_violation',
  '23503': 'foreign_key_violation',
  '23502': 'not_null_violation',
  '23514': 'check_violation',
  '23P01': 'exclusion_violation',
  '42501': 'insufficient_privilege',
  '40001': 'serialization_failure',
  '40P01': 'deadlock_detected',
  '55P03': 'lock_not_available',
  '57014': 'query_canceled',
};

interface ExtractedPgError {
  code: string;
  constraint?: string;
  /** The PostgreSQL error's own message, when it carries one. */
  message?: string;
}

/**
 * PostgreSQL SQLSTATE codes are exactly five uppercase alphanumeric
 * characters. Node system errors (`ECONNREFUSED`, `ETIMEDOUT`, …) also carry a
 * `code` property but must NOT be treated as database errors — they signal
 * infrastructure failure and should propagate as thrown exceptions.
 */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Extracts PostgreSQL error details from a (possibly wrapped) error.
 * Drizzle wraps PostgreSQL errors in the .cause property, and consumers may
 * re-wrap Drizzle's error again, so the `cause` chain is walked to a bounded
 * depth (which also makes cyclic chains safe).
 *
 * Only objects whose `code` matches the SQLSTATE shape (five uppercase
 * alphanumerics) are recognized; anything else (e.g. Node system errors with
 * `code: 'ECONNREFUSED'`) returns `null` so callers rethrow.
 */
export function extractPgError(error: unknown): ExtractedPgError | null {
  let current: unknown = error;

  for (let depth = 0; depth < 10; depth++) {
    if (current === null || typeof current !== 'object') return null;

    const candidate = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && SQLSTATE_PATTERN.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: 'constraint' in candidate ? String(candidate.constraint) : undefined,
        message: typeof candidate.message === 'string' && candidate.message !== '' ? candidate.message : undefined,
      };
    }
    current = candidate.cause;
  }

  return null;
}

/**
 * Builds the OctDatabaseError for a recognized PostgreSQL error.
 *
 * Drizzle's wrapper message ("Failed query: …") drops the PostgreSQL cause,
 * so consumers that only surface `.message` (API responses, wrapped errors,
 * test output) lose the actual failure. Fold the SQLSTATE and the cause's
 * message back into the message so the diagnosis survives those paths.
 */
function toDatabaseError(error: unknown, pgError: ExtractedPgError): OctDatabaseError {
  const base = error instanceof Error ? error.message : 'Database operation failed';
  const causeMessage = pgError.message && !base.includes(pgError.message) ? ` ${pgError.message}` : '';

  return {
    key: 'database_error' as const,
    code: PG_ERROR_CODE_MAP[pgError.code] ?? 'unknown',
    constraint: pgError.constraint,
    message: `[${pgError.code}${causeMessage}] ${base}`,
  };
}

/**
 * Wraps a database operation that returns Result<T, E> and catches PostgreSQL errors.
 * If the callback returns a Result, it's passed through; if a PG error is thrown,
 * it's converted to OctDatabaseError.
 *
 * @example
 * ```ts
 * async function test(): Promise<Result<void, TestError | OctDatabaseError>> {
 *   return withDbErrorHandling(async () => {
 *     await db.select().from(tags).limit(1);
 *     return {
 *       ok: false,
 *       error: { key: 'test', message: 'Test error' },
 *     };
 *   });
 * }
 * ```
 */
export async function withDbErrorHandling<T, E extends OctError>(
  operation: () => Promise<Result<T, E>>,
): Promise<Result<T, E | OctDatabaseError>> {
  try {
    return await operation();
  } catch (error) {
    const pgError = extractPgError(error);

    if (pgError?.code) {
      return err(toDatabaseError(error, pgError));
    }

    // Re-throw non-PostgreSQL errors
    throw error;
  }
}

/**
 * Handles errors from db.transaction() calls, converting PostgreSQL errors
 * to OctDatabaseError and preserving typed errors from TransactionRollbackError.
 *
 * Use this in catch blocks around db.transaction() calls.
 *
 * @example
 * ```ts
 * try {
 *   await db.transaction(async (tx) => {
 *     const result = await orderService.create(params, tx);
 *     if (!result.ok) throw new TransactionRollbackError(result.error);
 *     // ... more operations
 *   });
 *   return { ok: true, value: undefined };
 * } catch (error) {
 *   return handleTransactionError(error);
 * }
 * ```
 */
export function handleTransactionError<E extends OctError>(
  error: unknown,
): Result<never, E | OctDatabaseError> {
  // Preserve typed errors from nested service calls
  if (error instanceof TransactionRollbackError) {
    return err(error.typedError as E);
  }

  // Convert PostgreSQL errors to OctDatabaseError
  const pgError = extractPgError(error);
  if (pgError?.code) {
    return err(toDatabaseError(error, pgError));
  }

  // Re-throw unexpected errors
  throw error;
}
