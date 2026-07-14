// Generic S3-compatible object-storage provider (storage `mode: 's3'`).
//
// Despite the AWS-prefixed symbol names and the `@aws-sdk/client-s3` dependency,
// this is NOT bound to Amazon S3: the client takes an explicit `endpoint` +
// `forcePathStyle`, so it talks to any S3-compatible store. Production points it
// at Hetzner Object Storage (EU). `@aws-sdk/client-s3` is used purely as the S3
// protocol client, not as an AWS service binding.
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type ObjectCannedACL } from '@aws-sdk/client-s3';
import type { ObjectStorageService, ObjectStorageUrlProvider } from '../../base/interfaces';
import type { ListObjectsResponse, StorageObject, StorageObjectWithHead } from '../../base/types';
import type { ObjectStorageError } from '../../base/errors';
import { toOctError, isAbortError, type Result } from '../../../result/index.ts';
import type { Logger } from '../../../logger/index.ts';
import { withRetry } from '../../internal/retry';

/**
 * Maps a namespace to the object-key prefix used inside the bucket.
 * Default: `` ns => `${ns}/` ``. No prefix is applied when the namespace is
 * omitted. Layouts produced before namespaces were generic (`tenant/<ns>/`)
 * are reproduced with `` ns => `tenant/${ns}/` ``.
 */
export type NamespacePrefixFn = (namespace: string) => string;

const defaultNamespacePrefix: NamespacePrefixFn = (namespace) => `${namespace}/`;

const createObjectKeyBuilder = (namespacePrefix: NamespacePrefixFn = defaultNamespacePrefix) => {
  const prefixFor = (namespace: string | undefined) => (namespace ? namespacePrefix(namespace) : '');
  const objectKey = (namespace: string | undefined, key: string) => `${prefixFor(namespace)}${key}`;
  return { prefixFor, objectKey };
};

/**
 * Defense-in-depth key check. Object keys are concatenated onto the namespace
 * prefix, so a key containing `..` path segments or starting with `/` could
 * escape its namespace once a CDN or browser normalizes the resulting URL
 * (e.g. `ns-a/../ns-b/secret` → `ns-b/secret`). Such keys are rejected before
 * any S3 call.
 */
const isUnsafeObjectKey = (key: string): boolean => {
  if (!key || key.startsWith('/')) return true;
  return key.split('/').some((segment) => segment === '..');
};

const invalidKeyError = (operation: string, key: string): ObjectStorageError => ({
  key: 'invalid_key',
  message: `Invalid object key during '${operation}': keys must be non-empty, must not start with '/', and must not contain '..' path segments (got '${key}')`,
});

export interface AWSObjectStorageUrlProviderConfig {
  readonly publicEndpoint: string;
  readonly namespacePrefix?: NamespacePrefixFn;
}

export interface AWSObjectStorageUrlProvider extends ObjectStorageUrlProvider {
  readonly type: 's3';
}

export const createAWSObjectStorageUrlProvider = (config: AWSObjectStorageUrlProviderConfig): AWSObjectStorageUrlProvider => {
  const { objectKey } = createObjectKeyBuilder(config.namespacePrefix);
  return {
    type: 's3' as const,
    getPublicUrl: ({ namespace, key }: { namespace?: string; key: string }) => {
      return `${config.publicEndpoint}/${objectKey(namespace, key)}`;
    },
  };
};

// Configuration - single shared bucket with namespace-prefixed keys
export interface AWSClientObjectStorageConfig {
  readonly bucket: string;
  readonly publicEndpoint: string;
  readonly region: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly defaultACL?: ObjectCannedACL;
  readonly namespacePrefix?: NamespacePrefixFn;
  readonly logger: Logger;
}

// AWS-specific error types
interface AWSError {
  readonly name: string;
  readonly message: string;
  readonly Code?: string;
  readonly statusCode?: number;
  readonly $fault?: 'client' | 'server';
}

// Error classification and mapping
const mapAWSErrorToRyError = (error: unknown, operation: string, context?: Record<string, string>): ObjectStorageError => {
  if (isAbortError(error)) {
    return {
      key: 'internal_error',
      message: `Object storage operation '${operation}' was aborted`
    };
  }

  if (isAWSError(error)) {
    const contextStr = context ? ` (${Object.entries(context).map(([k, v]) => `${k}: ${v}`).join(', ')})` : '';

    switch (error.name) {
      case 'NoSuchBucket':
        return {
          key: 'not_found_bucket',
          message: `Bucket not found during '${operation}'${contextStr}: ${error.message}`
        };
      case 'NoSuchKey':
        return {
          key: 'not_found',
          message: `Object not found during '${operation}'${contextStr}: ${error.message}`
        };
      case 'AccessDenied':
      case 'Forbidden':
        return {
          key: 'access_denied',
          message: `Access denied during '${operation}'${contextStr}: ${error.message}`
        };
      case 'BucketAlreadyExists':
      case 'BucketAlreadyOwnedByYou':
        return {
          key: 'internal_error',
          message: `Bucket already exists during '${operation}'${contextStr}: ${error.message}`
        };
      case 'InvalidBucketName':
        return {
          key: 'internal_error',
          message: `Invalid bucket name during '${operation}'${contextStr}: ${error.message}`
        };
      case 'NoCredentialsError':
        return {
          key: 'access_denied',
          message: `AWS credentials missing during '${operation}'${contextStr}`
        };
      case 'CredentialsProviderError':
        return {
          key: 'access_denied',
          message: `AWS credentials invalid during '${operation}'${contextStr}: ${error.message}`
        };
      case 'NetworkingError':
      case 'TimeoutError':
        return {
          key: 'network_error',
          message: `Network error during '${operation}'${contextStr}: ${error.message}`
        };
      case 'ThrottlingException':
      case 'RequestLimitExceeded':
        return {
          key: 'network_error',
          message: `Rate limit exceeded during '${operation}'${contextStr}: ${error.message}`
        };
      default:
        // Check for server vs client errors
        if (error.$fault === 'server' || (error.statusCode && error.statusCode >= 500)) {
          return {
            key: 'internal_error',
            message: `AWS server error during '${operation}'${contextStr}: ${error.message}`
          };
        }
        return {
          key: 'internal_error',
          message: `AWS client error during '${operation}'${contextStr}: ${error.message}`
        };
    }
  }

  // Fallback to general error conversion
  const octError = toOctError(error);
  return {
    key: 'internal_error',
    message: `Unknown error during '${operation}'${context ? ` (${Object.entries(context).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}: ${octError.message}`
  };
};

// AWS Error type guard
const isAWSError = (error: unknown): error is AWSError => {
  return typeof error === 'object' &&
         error !== null &&
         'name' in error &&
         'message' in error &&
         typeof (error as any).name === 'string';
};

// Check if error should be retried
const isRetryableError = (error: unknown): boolean => {
  if (isAbortError(error)) return false;

  if (isAWSError(error)) {
    // Retry on server errors and specific transient errors
    const retryableErrors = [
      'NetworkingError',
      'TimeoutError',
      'ThrottlingException',
      'RequestLimitExceeded',
      'ServiceUnavailable',
      'InternalServerError',
      'SlowDown'
    ];

    return retryableErrors.includes(error.name) ||
           error.$fault === 'server' ||
           (error.statusCode !== undefined && error.statusCode >= 500);
  }

  return false;
};

export interface AWSObjectStorageService extends ObjectStorageService {
  readonly type: 's3';
  readonly client: S3Client;
}

export const createAWSObjectStorageService = (config: AWSClientObjectStorageConfig): AWSObjectStorageService => {
  const { logger } = config;
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });

  const { prefixFor, objectKey } = createObjectKeyBuilder(config.namespacePrefix);
  const nsContext = (namespace: string | undefined) => namespace ?? '(root)';

  interface HeadObjectValue {
    readonly contentType: string | undefined;
    readonly contentLength: number | undefined;
    readonly metadata: Record<string, string> | undefined;
  }

  const headObject = async (
    namespace: string | undefined,
    params: { key: string }
  ): Promise<Result<HeadObjectValue, ObjectStorageError>> => {
    try {
      const result = await withRetry(
        () => client.send(new HeadObjectCommand({
          Bucket: config.bucket,
          Key: objectKey(namespace, params.key),
        })),
        'headObject',
        isRetryableError,
        { s3Bucket: config.bucket, namespace: nsContext(namespace), key: params.key }
      );
      return {
        ok: true,
        value: {
          contentType: result.ContentType,
          contentLength: result.ContentLength,
          metadata: result.Metadata,
        },
      };
    } catch (error) {
      const ryError = mapAWSErrorToRyError(error, 'headObject', { s3Bucket: config.bucket, namespace: nsContext(namespace), key: params.key });
      return {
        ok: false, error: ryError
      };
    }
  };

  const listObjects: ObjectStorageService['listObjects'] = async <T extends boolean>({ namespace, prefix, includeHead, continuationToken, maxKeys }: {
    namespace?: string;
    prefix?: string;
    includeHead: T;
    continuationToken?: string;
    maxKeys?: number;
  }) => {
    try {
      const s3Prefix = objectKey(namespace, prefix || '');
      const listCommand = new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: s3Prefix,
        ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        ...(maxKeys !== undefined ? { MaxKeys: maxKeys } : {}),
      });

      const data = await withRetry(
        () => client.send(listCommand),
        'listObjects',
        isRetryableError,
        { s3Bucket: config.bucket, namespace: nsContext(namespace), prefix: prefix || 'all' }
      );

      // The token for the NEXT page is NextContinuationToken; ContinuationToken
      // merely echoes the request. Undefined when this is the last page.
      const nextContinuationToken = data.NextContinuationToken;

      // Strip the namespace prefix from returned keys so they match what callers uploaded
      const prefixToStrip = prefixFor(namespace);
      const objects: StorageObject[] = data.Contents?.map((o) => ({
        key: o.Key!.startsWith(prefixToStrip) ? o.Key!.slice(prefixToStrip.length) : o.Key!,
        size: o.Size!,
      })) || [];

      if (includeHead) {
        const augmentedObjects: StorageObjectWithHead[] = await Promise.all(
          objects.map(async (obj) => {
            const head = await headObject(namespace, { key: obj.key });
            if (!head.ok) {
              // Log error but continue with the documented fallbacks
              logger.warn('Failed to get head for object', { key: obj.key, s3Bucket: config.bucket, namespace: nsContext(namespace), error: head.error.message });
              return {
                ...obj,
                metadata: {},
                contentType: 'application/octet-stream', // fallback
              };
            }
            return {
              key: obj.key,
              size: head.value.contentLength ?? obj.size,
              metadata: head.value.metadata ?? {},
              contentType: head.value.contentType ?? 'application/octet-stream',
            };
          })
        );
        return {
          ok: true,
          value: {
            continuationToken: nextContinuationToken,
            objects: augmentedObjects,
          } as ListObjectsResponse<T>,
        };
      }

      // TS cannot correlate the runtime `includeHead` check with the
      // conditional return type, so a fully-typed ListObjectsResponse<false>
      // is built first and only then converted.
      const response: ListObjectsResponse<false> = {
        continuationToken: nextContinuationToken,
        objects,
      };
      return {
        ok: true,
        value: response as unknown as ListObjectsResponse<T>,
      };
    } catch (error) {
      const ryError = mapAWSErrorToRyError(error, 'listObjects', {
        s3Bucket: config.bucket,
        namespace: nsContext(namespace),
        prefix: prefix || 'all'
      });
      return { ok: false, error: ryError };
    }
  };

  const uploadObject: ObjectStorageService['uploadObject'] = async ({ namespace, key, metadata, body }: {
    namespace?: string;
    key: string;
    metadata?: { readonly [key: string]: string };
    body: Uint8Array | ReadableStream<Uint8Array>;
  }) => {
    if (isUnsafeObjectKey(key)) {
      return { ok: false as const, error: invalidKeyError('uploadObject', key) };
    }

    // Same content-type convention as the Postgres provider: an explicit
    // `content-type`/`contentType` metadata entry becomes the object's real
    // Content-Type (served on GET), falling back to application/octet-stream.
    const contentType = metadata?.['content-type'] || metadata?.['contentType'] || 'application/octet-stream';

    try {
      await withRetry(
        () => client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: objectKey(namespace, key),
          Body: body,
          Metadata: metadata,
          ContentType: contentType,
          ...(config.defaultACL ? { ACL: config.defaultACL } : {}),
        })),
        'uploadObject',
        isRetryableError,
        { s3Bucket: config.bucket, namespace: nsContext(namespace), key }
      );
      return { ok: true, value: undefined };
    } catch (error) {
      const ryError = mapAWSErrorToRyError(error, 'uploadObject', {
        s3Bucket: config.bucket,
        namespace: nsContext(namespace),
        key
      });
      return { ok: false, error: ryError };
    }
  };

  const deleteObject: ObjectStorageService['deleteObject'] = async ({ namespace, key }: { namespace?: string; key: string }) => {
    if (isUnsafeObjectKey(key)) {
      return { ok: false as const, error: invalidKeyError('deleteObject', key) };
    }
    try {
      await withRetry(
        () => client.send(new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: objectKey(namespace, key),
        })),
        'deleteObject',
        isRetryableError,
        { s3Bucket: config.bucket, namespace: nsContext(namespace), key }
      );
      return { ok: true, value: undefined };
    } catch (error) {
      // Special handling for NoSuchKey errors - treat as success for idempotent deletes
      if (isAWSError(error) && error.name === 'NoSuchKey') {
        logger.info('Object does not exist, treating delete as successful', { key, s3Bucket: config.bucket, namespace: nsContext(namespace) });
        return { ok: true, value: undefined };
      }

      const ryError = mapAWSErrorToRyError(error, 'deleteObject', {
        s3Bucket: config.bucket,
        namespace: nsContext(namespace),
        key
      });
      return { ok: false, error: ryError };
    }
  };

  const deleteObjectsByPrefix: ObjectStorageService['deleteObjectsByPrefix'] = async ({ namespace, prefix }: { namespace?: string; prefix?: string }) => {
    // Safety: without a prefix this would delete the entire namespace (or the
    // whole bucket when no namespace is set). Require an explicit prefix.
    if (!prefix) {
      return {
        ok: false as const,
        error: {
          key: 'invalid_prefix' as const,
          message: "deleteObjectsByPrefix requires a non-empty 'prefix' — a missing prefix would delete every object in the namespace/bucket",
        },
      };
    }

    const s3Prefix = objectKey(namespace, prefix);
    let continuationToken: string | undefined;
    let totalDeleted = 0;

    try {
      do {
        const list = await withRetry(
          () => client.send(new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: s3Prefix,
            ContinuationToken: continuationToken,
          })),
          'deleteObjectsByPrefix.list',
          isRetryableError,
          { s3Bucket: config.bucket, namespace: nsContext(namespace), prefix: prefix || 'all' }
        );

        const keys = (list.Contents ?? []).map(o => o.Key).filter((k): k is string => typeof k === 'string');
        if (keys.length === 0) {
          continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
          continue;
        }

        // S3 DeleteObjects supports up to 1000 keys per call; ListObjectsV2 returns up to 1000.
        await withRetry(
          () => client.send(new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true },
          })),
          'deleteObjectsByPrefix.delete',
          isRetryableError,
          { s3Bucket: config.bucket, namespace: nsContext(namespace), batchSize: String(keys.length) }
        );

        totalDeleted += keys.length;
        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (continuationToken);

      return { ok: true, value: { deleted: totalDeleted } };
    } catch (error) {
      const ryError = mapAWSErrorToRyError(error, 'deleteObjectsByPrefix', {
        s3Bucket: config.bucket,
        namespace: nsContext(namespace),
        prefix: prefix || 'all',
      });
      return { ok: false, error: ryError };
    }
  };

  const getPublicUrl: ObjectStorageService['getPublicUrl'] = ({ namespace, key }) => {
    return `${config.publicEndpoint}/${objectKey(namespace, key)}`;
  };

  const getObjectData: ObjectStorageService['getObjectData'] = async ({ namespace, key }: { namespace?: string; key: string }) => {
    if (isUnsafeObjectKey(key)) {
      return { ok: false as const, error: invalidKeyError('getObjectData', key) };
    }
    try {
      const result = await withRetry(
        () => client.send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: objectKey(namespace, key),
        })),
        'getObjectData',
        isRetryableError,
        { s3Bucket: config.bucket, namespace: nsContext(namespace), key }
      );

      if (!result.Body) {
        return {
          ok: false,
          error: { key: 'not_found', message: `Object not found: ${key}` },
        };
      }

      const bytes = await result.Body.transformToByteArray();
      const data = Buffer.from(bytes);

      return {
        ok: true,
        value: {
          data,
          size: result.ContentLength ?? data.length,
          contentType: result.ContentType ?? 'application/octet-stream',
          metadata: result.Metadata ?? {},
          lastModified: (result.LastModified ?? new Date(0)).toISOString(),
        },
      };
    } catch (error) {
      // S3 returns NoSuchKey when the object is absent — surface as a typed not_found.
      if (isAWSError(error) && error.name === 'NoSuchKey') {
        return {
          ok: false,
          error: { key: 'not_found', message: `Object not found: ${key}` },
        };
      }
      const ryError = mapAWSErrorToRyError(error, 'getObjectData', { s3Bucket: config.bucket, namespace: nsContext(namespace), key });
      return { ok: false, error: ryError };
    }
  };

  return {
    type: 's3' as const,
    client,
    getPublicUrl,
    listObjects,
    uploadObject,
    deleteObject,
    deleteObjectsByPrefix,
    getObjectData,
  };
};
