import { type Result, type OctError, err } from '@octabits-io/foundation/result';
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
 *   const result = await paymentService.create(tenantId, params, tx);
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
};

interface ExtractedPgError {
  code: string;
  constraint?: string;
}

/**
 * Extracts PostgreSQL error details from a Drizzle-wrapped error.
 * Drizzle wraps PostgreSQL errors in the .cause property.
 */
export function extractPgError(error: unknown): ExtractedPgError | null {
  const pgError = error instanceof Error && 'cause' in error ? error.cause : error;

  if (pgError && typeof pgError === 'object' && 'code' in pgError) {
    return {
      code: String(pgError.code),
      constraint: 'constraint' in pgError ? String(pgError.constraint) : undefined,
    };
  }

  return null;
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
      const code = PG_ERROR_CODE_MAP[pgError.code] ?? 'unknown';
      return err({
        key: 'database_error' as const,
        code,
        constraint: pgError.constraint,
        message: error instanceof Error ? error.message : 'Database operation failed',
      });
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
 *     const result = await paymentService.create(tenantId, params, tx);
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
    const code = PG_ERROR_CODE_MAP[pgError.code] ?? 'unknown';
    return err({
      key: 'database_error' as const,
      code,
      constraint: pgError.constraint,
      message: error instanceof Error ? error.message : 'Database operation failed',
    });
  }

  // Re-throw unexpected errors
  throw error;
}
