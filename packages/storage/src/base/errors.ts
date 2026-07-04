import type { OctErrorWithKey } from '@octabits-io/foundation/result';

export type ObjectStorageError = OctErrorWithKey<'network_error' | 'not_found' | 'not_found_bucket' | 'access_denied' | 'internal_error'>;
