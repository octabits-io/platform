import type { Result } from '@octabits-io/foundation/result';
import type { ObjectStorageError } from './errors';
import type { ListObjectsResponse, ObjectData } from './types';

/**
 * Minimal interface for serving files from object storage.
 * Used by handler functions that only need to read object data.
 */
export interface ObjectFileServer {
  readonly getObjectData: (params: { namespace?: string; key: string }) => Promise<Result<ObjectData, ObjectStorageError>>;
}

/**
 * URL provider for object storage.
 *
 * `namespace` is an optional logical partition for objects (e.g. a tenant id,
 * an environment name, or nothing at all). When omitted, objects live in the
 * root namespace.
 *
 * Implementations should add a `type` discriminator for type narrowing:
 * @example
 * ```typescript
 * interface MyUrlProvider extends ObjectStorageUrlProvider {
 *   readonly type: 'my-provider';
 * }
 * ```
 */
export interface ObjectStorageUrlProvider {
  readonly type?: string;
  readonly getPublicUrl: (params: { namespace?: string; key: string }) => string;
}

/**
 * Object storage service interface.
 *
 * Extends ObjectStorageUrlProvider to provide full storage capabilities.
 * All methods accept an optional `namespace` that partitions objects; how it
 * is realized (key prefix, table column, ...) is provider-specific. Omitting
 * it addresses the root namespace, so single-partition consumers never have
 * to invent a namespace value.
 *
 * Implementations should add a `type` discriminator for type narrowing:
 * @example
 * ```typescript
 * interface MyStorageService extends ObjectStorageService {
 *   readonly type: 'my-provider';
 * }
 * ```
 */
export interface ObjectStorageService extends ObjectStorageUrlProvider {
  readonly listObjects: <T extends boolean>(params: {
    namespace?: string;
    prefix?: string;
    includeHead: T;
    /**
     * Opaque continuation token from a previous page
     * (`ListObjectsResponse.continuationToken`). Pass it to fetch the next
     * page. Provider-specific: the S3 provider pages at up to 1000 objects;
     * the Postgres provider returns everything in one page and ignores this.
     */
    continuationToken?: string;
    /** Maximum number of objects per page (provider-specific cap, e.g. 1000 on S3). */
    maxKeys?: number;
  }) => Promise<Result<ListObjectsResponse<T>, ObjectStorageError>>;
  readonly uploadObject: (params: {
    namespace?: string;
    key: string;
    metadata?: { readonly [key: string]: string };
    body: Uint8Array | ReadableStream<Uint8Array>;
  }) => Promise<Result<void, ObjectStorageError>>;
  readonly deleteObject: (params: { namespace?: string; key: string }) => Promise<Result<void, ObjectStorageError>>;
  /**
   * Delete every object whose key starts with `prefix`. A non-empty `prefix`
   * is required — calling without one would wipe the entire namespace (or, on
   * S3 with no namespace, the entire bucket), so providers return an
   * `invalid_prefix` error instead. Use an explicit listing + `deleteObject`
   * loop if a full wipe is genuinely intended.
   */
  readonly deleteObjectsByPrefix: (params: { namespace?: string; prefix?: string }) => Promise<Result<{ deleted: number }, ObjectStorageError>>;
  readonly getObjectData: (params: { namespace?: string; key: string }) => Promise<Result<ObjectData, ObjectStorageError>>;
}
