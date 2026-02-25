import { describe, it, expect } from 'vitest';
import {
  TransactionRollbackError,
  PG_ERROR_CODE_MAP,
  extractPgError,
  withDbErrorHandling,
  handleTransactionError,
} from './error-handling.ts';
import type { OctDatabaseError } from './errors.ts';

// ============================================================================
// TransactionRollbackError
// ============================================================================

describe('TransactionRollbackError', () => {
  it('preserves the typed error', () => {
    const typedError = { key: 'not_found' as const, message: 'Missing resource' };
    const err = new TransactionRollbackError(typedError);

    expect(err.typedError).toBe(typedError);
    expect(err.message).toBe('Missing resource');
    expect(err.name).toBe('TransactionRollbackError');
  });

  it('is an instance of Error', () => {
    const err = new TransactionRollbackError({ key: 'test', message: 'test' });
    expect(err).toBeInstanceOf(Error);
  });
});

// ============================================================================
// PG_ERROR_CODE_MAP
// ============================================================================

describe('PG_ERROR_CODE_MAP', () => {
  it('maps 23505 to unique_violation', () => {
    expect(PG_ERROR_CODE_MAP['23505']).toBe('unique_violation');
  });

  it('maps 23503 to foreign_key_violation', () => {
    expect(PG_ERROR_CODE_MAP['23503']).toBe('foreign_key_violation');
  });

  it('maps 23502 to not_null_violation', () => {
    expect(PG_ERROR_CODE_MAP['23502']).toBe('not_null_violation');
  });

  it('maps 23514 to check_violation', () => {
    expect(PG_ERROR_CODE_MAP['23514']).toBe('check_violation');
  });

  it('returns undefined for unknown codes', () => {
    expect(PG_ERROR_CODE_MAP['99999']).toBeUndefined();
  });
});

// ============================================================================
// extractPgError
// ============================================================================

describe('extractPgError', () => {
  it('extracts code from a Drizzle-wrapped error (error.cause)', () => {
    const pgError = { code: '23505', constraint: 'users_email_unique' };
    const drizzleError = new Error('Query failed');
    (drizzleError as any).cause = pgError;

    const result = extractPgError(drizzleError);
    expect(result).toEqual({ code: '23505', constraint: 'users_email_unique' });
  });

  it('extracts code from a direct error object with code', () => {
    const pgError = { code: '23503' };
    const result = extractPgError(pgError);
    expect(result).toEqual({ code: '23503', constraint: undefined });
  });

  it('returns null for a plain Error without cause', () => {
    const error = new Error('something broke');
    expect(extractPgError(error)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractPgError(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractPgError(undefined)).toBeNull();
  });

  it('returns null for a string', () => {
    expect(extractPgError('some error')).toBeNull();
  });

  it('extracts code from error with cause that has code but no constraint', () => {
    const drizzleError = new Error('Query failed');
    (drizzleError as any).cause = { code: '23502' };

    const result = extractPgError(drizzleError);
    expect(result).toEqual({ code: '23502', constraint: undefined });
  });
});

// ============================================================================
// withDbErrorHandling
// ============================================================================

describe('withDbErrorHandling', () => {
  it('passes through a successful result', async () => {
    const result = await withDbErrorHandling(async () => ({
      ok: true as const,
      value: { id: 1 },
    }));

    expect(result).toEqual({ ok: true, value: { id: 1 } });
  });

  it('passes through an error result from the operation', async () => {
    const result = await withDbErrorHandling(async () => ({
      ok: false as const,
      error: { key: 'not_found' as const, message: 'Not found' },
    }));

    expect(result).toEqual({ ok: false, error: { key: 'not_found', message: 'Not found' } });
  });

  it('catches a PostgreSQL unique_violation and returns OctDatabaseError', async () => {
    const result = await withDbErrorHandling(async () => {
      const pgError = { code: '23505', constraint: 'users_email_unique' };
      const error = new Error('duplicate key value violates unique constraint');
      (error as any).cause = pgError;
      throw error;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error as OctDatabaseError;
      expect(err.key).toBe('database_error');
      expect(err.code).toBe('unique_violation');
      expect(err.constraint).toBe('users_email_unique');
      expect(err.message).toBe('duplicate key value violates unique constraint');
    }
  });

  it('catches a PostgreSQL foreign_key_violation', async () => {
    const result = await withDbErrorHandling(async () => {
      const pgError = { code: '23503', constraint: 'orders_user_id_fkey' };
      const error = new Error('insert or update violates foreign key constraint');
      (error as any).cause = pgError;
      throw error;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error as OctDatabaseError;
      expect(err.code).toBe('foreign_key_violation');
      expect(err.constraint).toBe('orders_user_id_fkey');
    }
  });

  it('maps unknown PG error codes to "unknown"', async () => {
    const result = await withDbErrorHandling(async () => {
      const pgError = { code: '42P01' }; // undefined_table
      const error = new Error('relation does not exist');
      (error as any).cause = pgError;
      throw error;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error as OctDatabaseError;
      expect(err.code).toBe('unknown');
    }
  });

  it('re-throws non-PostgreSQL errors', async () => {
    await expect(
      withDbErrorHandling(async () => {
        throw new Error('network timeout');
      }),
    ).rejects.toThrow('network timeout');
  });

  it('uses "Database operation failed" as message for non-Error throws', async () => {
    const result = await withDbErrorHandling(async () => {
      const obj = { code: '23505' };
      throw obj;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error as OctDatabaseError;
      expect(err.message).toBe('Database operation failed');
    }
  });
});

// ============================================================================
// handleTransactionError
// ============================================================================

describe('handleTransactionError', () => {
  it('preserves typed error from TransactionRollbackError', () => {
    const typedError = { key: 'validation_error' as const, message: 'Invalid email' };
    const rollbackError = new TransactionRollbackError(typedError);

    const result = handleTransactionError(rollbackError);
    expect(result).toEqual({ ok: false, error: typedError });
  });

  it('converts PostgreSQL errors to OctDatabaseError', () => {
    const pgError = { code: '23505', constraint: 'users_email_unique' };
    const error = new Error('duplicate key');
    (error as any).cause = pgError;

    const result = handleTransactionError(error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error as OctDatabaseError;
      expect(err.key).toBe('database_error');
      expect(err.code).toBe('unique_violation');
      expect(err.constraint).toBe('users_email_unique');
    }
  });

  it('re-throws unexpected errors', () => {
    const error = new Error('unexpected failure');
    expect(() => handleTransactionError(error)).toThrow('unexpected failure');
  });

  it('re-throws non-Error objects without PG code', () => {
    expect(() => handleTransactionError('string error')).toThrow();
  });
});
