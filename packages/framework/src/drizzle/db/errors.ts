import type { OctError } from '../../result/index.ts';

/**
 * Common PostgreSQL error codes mapped to semantic names.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export type PostgresErrorCode =
  | 'unique_violation' // 23505
  | 'foreign_key_violation' // 23503
  | 'not_null_violation' // 23502
  | 'check_violation' // 23514
  | 'exclusion_violation' // 23P01 (e.g. overlapping range EXCLUDE constraints)
  | 'insufficient_privilege' // 42501 (incl. row-level security policy violations)
  | 'serialization_failure' // 40001
  | 'deadlock_detected' // 40P01
  | 'lock_not_available' // 55P03 (NOWAIT / lock_timeout)
  | 'query_canceled' // 57014 (statement_timeout / cancel request)
  | 'unknown';

/**
 * Error returned when a database operation fails due to a constraint violation
 * or other PostgreSQL-specific error.
 */
export interface OctDatabaseError extends OctError {
  key: 'database_error';
  code: PostgresErrorCode;
  constraint?: string;
  message: string;
}
