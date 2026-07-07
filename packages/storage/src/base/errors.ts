import type { OctErrorWithKey } from '@octabits-io/foundation/result';

export type ObjectStorageError = OctErrorWithKey<
  | 'network_error'
  | 'not_found'
  | 'not_found_bucket'
  | 'access_denied'
  /** The object key is unsafe (path traversal segment, leading slash, or empty). */
  | 'invalid_key'
  /** `deleteObjectsByPrefix` was called without a non-empty prefix. */
  | 'invalid_prefix'
  | 'internal_error'
>;
