import { describe, it, expect } from 'vitest';
import { ok, err } from '../../result/index.ts';
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

  it('maps 40001 to serialization_failure', () => {
    expect(PG_ERROR_CODE_MAP['40001']).toBe('serialization_failure');
  });

  it('maps 40P01 to deadlock_detected', () => {
    expect(PG_ERROR_CODE_MAP['40P01']).toBe('deadlock_detected');
  });

  it('maps 23P01 to exclusion_violation', () => {
    expect(PG_ERROR_CODE_MAP['23P01']).toBe('exclusion_violation');
  });

  it('maps 42501 to insufficient_privilege', () => {
    expect(PG_ERROR_CODE_MAP['42501']).toBe('insufficient_privilege');
  });

  it('maps 55P03 to lock_not_available', () => {
    expect(PG_ERROR_CODE_MAP['55P03']).toBe('lock_not_available');
  });

  it('maps 57014 to query_canceled', () => {
    expect(PG_ERROR_CODE_MAP['57014']).toBe('query_canceled');
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

  it('returns null for a Node system error (code is not a SQLSTATE)', () => {
    const sysError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
    });
    expect(extractPgError(sysError)).toBeNull();
  });

  it('returns null for ETIMEDOUT wrapped in a cause', () => {
    const wrapped = new Error('query failed');
    (wrapped as any).cause = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(extractPgError(wrapped)).toBeNull();
  });

  it('returns null when code is not a string (numeric errno-style code)', () => {
    expect(extractPgError({ code: 23505 })).toBeNull();
  });

  it('recognizes alphanumeric SQLSTATE codes like 40P01', () => {
    expect(extractPgError({ code: '40P01' })).toEqual({ code: '40P01', constraint: undefined });
  });

  it('walks a multi-level cause chain (re-wrapped Drizzle error)', () => {
    const pgError = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const drizzleError = new Error('Failed query: …');
    (drizzleError as any).cause = pgError;
    const rewrapped = new Error('transfer step failed');
    (rewrapped as any).cause = drizzleError;

    expect(extractPgError(rewrapped)).toEqual({
      code: '40P01',
      constraint: undefined,
      message: 'deadlock detected',
    });
  });

  it('terminates on a cyclic cause chain', () => {
    const error = new Error('cyclic');
    (error as any).cause = error;
    expect(extractPgError(error)).toBeNull();
  });
});

// ============================================================================
// withDbErrorHandling
// ============================================================================

describe('withDbErrorHandling', () => {
  it('passes through a successful result', async () => {
    const result = await withDbErrorHandling(async () => ok({ id: 1 }));

    expect(result).toEqual({ ok: true, value: { id: 1 } });
  });

  it('passes through an error result from the operation', async () => {
    const result = await withDbErrorHandling(async () => err({ key: 'not_found' as const, message: 'Not found' }));

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
      expect(err.message).toBe('[23505] duplicate key value violates unique constraint');
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

  it('re-throws Node system errors instead of mapping them to database_error', async () => {
    const sysError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
    });
    await expect(
      withDbErrorHandling(async () => {
        throw sysError;
      }),
    ).rejects.toBe(sysError);
  });

  it('maps serialization failures (40001) to a distinct code', async () => {
    const result = await withDbErrorHandling(async () => {
      const error = new Error('could not serialize access');
      (error as any).cause = { code: '40001' };
      throw error;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as OctDatabaseError).code).toBe('serialization_failure');
  });

  it('maps deadlocks (40P01) to a distinct code', async () => {
    const result = await withDbErrorHandling(async () => {
      const error = new Error('deadlock detected');
      (error as any).cause = { code: '40P01' };
      throw error;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as OctDatabaseError).code).toBe('deadlock_detected');
  });

  it('folds the PostgreSQL cause message into the wrapper message', async () => {
    // Drizzle wraps pg errors: the wrapper says "Failed query: …" and the
    // actual diagnosis ("deadlock detected") lives only on .cause.
    const result = await withDbErrorHandling(async () => {
      const error = new Error('Failed query: insert into "uploaded_asset" …');
      (error as any).cause = Object.assign(new Error('deadlock detected'), { code: '40P01' });
      throw error;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error as OctDatabaseError;
      expect(err.code).toBe('deadlock_detected');
      expect(err.message).toBe('[40P01 deadlock detected] Failed query: insert into "uploaded_asset" …');
    }
  });

  it('folds the pg message from a re-wrapped (multi-level) cause chain', async () => {
    const result = await withDbErrorHandling(async () => {
      const pgError = Object.assign(new Error('conflicting key value violates exclusion constraint'), {
        code: '23P01',
        constraint: 'resource_range_excl',
      });
      const drizzleError = new Error('Failed query: insert into "resource" …');
      (drizzleError as any).cause = pgError;
      const rewrapped = new Error('transfer step failed');
      (rewrapped as any).cause = drizzleError;
      throw rewrapped;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error as OctDatabaseError;
      expect(err.code).toBe('exclusion_violation');
      expect(err.constraint).toBe('resource_range_excl');
      expect(err.message).toBe(
        '[23P01 conflicting key value violates exclusion constraint] transfer step failed',
      );
    }
  });

  it('does not duplicate the cause message when the wrapper already contains it', async () => {
    const result = await withDbErrorHandling(async () => {
      const error = new Error('deadlock detected');
      (error as any).cause = Object.assign(new Error('deadlock detected'), { code: '40P01' });
      throw error;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as OctDatabaseError).message).toBe('[40P01] deadlock detected');
    }
  });

  it('uses "Database operation failed" as message for non-Error throws', async () => {
    const result = await withDbErrorHandling(async () => {
      const obj = { code: '23505' };
      throw obj;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error as OctDatabaseError;
      expect(err.message).toBe('[23505] Database operation failed');
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

  it('re-throws Node system errors instead of mapping them', () => {
    const sysError = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(() => handleTransactionError(sysError)).toThrow('connect ETIMEDOUT');
  });
});
