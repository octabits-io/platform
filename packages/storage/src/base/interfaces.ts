import type { Result } from '@octabits-io/foundation/result';
import type { ObjectStorageError } from './errors';
import type { ListObjectsResponse, ObjectData } from './types';

/**
 * Minimal interface for serving files from object storage.
 * Used by handler functions that only need to read object data.
 */
export interface ObjectFileServer {
  readonly getObjectData: (params: { tenant: string; key: string }) => Promise<Result<ObjectData, ObjectStorageError>>;
}

/**
 * URL provider for object storage.
 *
 * Takes `tenant` as a method parameter to identify the tenant namespace.
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
  readonly getPublicUrl: (params: { tenant: string; key: string }) => string;
}

/**
 * Object storage service interface.
 *
 * Extends ObjectStorageUrlProvider to provide full storage capabilities.
 * All methods take `tenant` as a parameter to identify the tenant namespace.
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
    tenant: string;
    prefix?: string;
    includeHead: T;
  }) => Promise<Result<ListObjectsResponse<T>, ObjectStorageError>>;
  readonly uploadObject: (params: {
    tenant: string;
    key: string;
    metadata?: { readonly [key: string]: string };
    body: Uint8Array | ReadableStream<Uint8Array>;
  }) => Promise<Result<void, ObjectStorageError>>;
  readonly deleteObject: (params: { tenant: string; key: string }) => Promise<Result<void, ObjectStorageError>>;
  readonly deleteObjectsByPrefix: (params: { tenant: string; prefix?: string }) => Promise<Result<{ deleted: number }, ObjectStorageError>>;
  readonly getObjectData: (params: { tenant: string; key: string }) => Promise<Result<ObjectData, ObjectStorageError>>;
}
