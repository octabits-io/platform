/**
 * Pagination utilities for handling unlimited result sets.
 */

/**
 * Safety cap for unlimited queries to prevent OOM issues.
 * When limit=-1 is requested, this is the maximum number of results returned.
 */
export const MAX_UNLIMITED_RESULTS = 10000;

/**
 * Normalizes the pagination limit value.
 * - If limit is -1 (all items), returns MAX_UNLIMITED_RESULTS
 * - Otherwise, returns the original limit
 *
 * @param limit - The limit value from the API request
 * @returns The normalized limit to use in database queries
 */
export function normalizePaginationLimit(limit: number): number {
  return limit === -1 ? MAX_UNLIMITED_RESULTS : limit;
}
