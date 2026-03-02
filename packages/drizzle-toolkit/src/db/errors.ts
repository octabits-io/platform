import type { OctError } from '@octabits-io/foundation/result';

/**
 * Common PostgreSQL error codes mapped to semantic names.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export type PostgresErrorCode =
  | 'unique_violation' // 23505
  | 'foreign_key_violation' // 23503
  | 'not_null_violation' // 23502
  | 'check_violation' // 23514
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
