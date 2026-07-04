// Generic S3-compatible object-storage provider (storage `mode: 's3'`).
//
// Despite the AWS-prefixed symbol names and the `@aws-sdk/client-s3` dependency,
// this is NOT bound to Amazon S3: the client takes an explicit `endpoint` +
// `forcePathStyle`, so it talks to any S3-compatible store. Production points it
// at Hetzner Object Storage (EU). `@aws-sdk/client-s3` is used purely as the S3
// protocol client, not as an AWS service binding.
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type ObjectCannedACL } from '@aws-sdk/client-s3';
import type { ObjectStorageService, ObjectStorageUrlProvider } from '../../base/interfaces';
import type { ListObjectsResponse } from '../../base/types';
import type { ObjectStorageError } from '../../base/errors';
import { toOctError, isAbortError } from '@octabits-io/foundation/result';
import type { Logger } from '@octabits-io/foundation/logger';
import { withRetry } from '../../internal/retry';

export interface AWSObjectStorageUrlProviderConfig {
  readonly publicEndpoint: string;
}

export interface AWSObjectStorageUrlProvider extends ObjectStorageUrlProvider {
  readonly type: 's3';
}

export const createAWSObjectStorageUrlProvider = (config: AWSObjectStorageUrlProviderConfig): AWSObjectStorageUrlProvider => {
  return {
    type: 's3' as const,
    getPublicUrl: ({ tenant, key }: { tenant: string; key: string }) => {
      return `${config.publicEndpoint}/tenant/${tenant}/${key}`;
    },
  };
};

// Configuration - single shared bucket with tenant-prefixed keys
export interface AWSClientObjectStorageConfig {
  readonly bucket: string;
  readonly publicEndpoint: string;
  readonly region: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly defaultACL?: ObjectCannedACL;
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
          key: 'not_found',
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

  const tenantKey = (tenant: string, key: string) => `tenant/${tenant}/${key}`;

  const headObject = async (tenant: string, params: { key: string }) => {
    try {
      const result = await withRetry(
        () => client.send(new HeadObjectCommand({
          Bucket: config.bucket,
          Key: tenantKey(tenant, params.key),
        })),
        'headObject',
        isRetryableError,
        { s3Bucket: config.bucket, tenant, key: params.key }
      );
      return {
        contentType: result.ContentType!,
        contentLength: result.ContentLength!,
        metadata: result.Metadata!,
      };
    } catch (error) {
      const ryError = mapAWSErrorToRyError(error, 'headObject', { s3Bucket: config.bucket, tenant, key: params.key });
      return {
        ok: false, error: ryError
      };
    }
  };

  const listObjects: ObjectStorageService['listObjects'] = async <T extends boolean>({ tenant, prefix, includeHead }: {
    tenant: string;
    prefix?: string;
    includeHead: T;
  }) => {
    try {
      const s3Prefix = tenantKey(tenant, prefix || '');
      const listCommand = new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: s3Prefix,
      });

      const data = await withRetry(
        () => client.send(listCommand),
        'listObjects',
        isRetryableError,
        { s3Bucket: config.bucket, tenant, prefix: prefix || 'all' }
      );

      // Strip tenant prefix from returned keys so they match what's stored in the database
      const prefixToStrip = `tenant/${tenant}/`;
      const objects = data.Contents?.map((o) => ({
        key: o.Key!.startsWith(prefixToStrip) ? o.Key!.slice(prefixToStrip.length) : o.Key!,
        size: o.Size!,
      })) || [];

      if (includeHead) {
        try {
          const augmentedObjects = await Promise.all(
            objects.map(async (obj) => {
              try {
                const head = await headObject(tenant, { key: obj.key });
                return {
                  ...obj,
                  metadata: head.metadata,
                  contentType: head.contentType,
                };
              } catch (error) {
                // Log error but continue with partial data
                logger.warn('Failed to get head for object', { key: obj.key, s3Bucket: config.bucket, tenant, error: error instanceof Error ? error.message : String(error) });
                return {
                  ...obj,
                  metadata: {},
                  contentType: 'application/octet-stream', // fallback
                };
              }
            })
          );
          return {
            ok: true,
            value: {
              continuationToken: data.ContinuationToken,
              objects: augmentedObjects as unknown,
            } as ListObjectsResponse<T>,
          };
        } catch (error) {
          const ryError = mapAWSErrorToRyError(error, 'listObjects.includeHead', {
            s3Bucket: config.bucket,
            tenant,
            prefix: prefix || 'all'
          });
          return { ok: false, error: ryError };
        }
      }

      return {
        ok: true,
        value: {
          continuationToken: data.ContinuationToken,
          objects: objects as unknown,
        } as ListObjectsResponse<T>,
      };
    } catch (error) {
      const ryError = mapAWSErrorToRyError(error, 'listObjects', {
        s3Bucket: config.bucket,
        tenant,
        prefix: prefix || 'all'
      });
      return { ok: false, error: ryError };
    }
  };

  const uploadObject: ObjectStorageService['uploadObject'] = async ({ tenant, key, metadata, body }: {
    tenant: string;
    key: string;
    metadata?: { readonly [key: string]: string };
    body: Uint8Array | ReadableStream<Uint8Array>;
  }) => {
    try {
      await withRetry(
        () => client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: tenantKey(tenant, key),
          Body: body,
          Metadata: metadata,
          ...(config.defaultACL ? { ACL: config.defaultACL } : {}),
        })),
        'uploadObject',
        isRetryableError,
        { s3Bucket: config.bucket, tenant, key }
      );
      return { ok: true, value: undefined };
    } catch (error) {
      const ryError = mapAWSErrorToRyError(error, 'uploadObject', {
        s3Bucket: config.bucket,
        tenant,
        key
      });
      return { ok: false, error: ryError };
    }
  };

  const deleteObject: ObjectStorageService['deleteObject'] = async ({ tenant, key }: { tenant: string; key: string }) => {
    try {
      await withRetry(
        () => client.send(new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: tenantKey(tenant, key),
        })),
        'deleteObject',
        isRetryableError,
        { s3Bucket: config.bucket, tenant, key }
      );
      return { ok: true, value: undefined };
    } catch (error) {
      // Special handling for NoSuchKey errors - treat as success for idempotent deletes
      if (isAWSError(error) && error.name === 'NoSuchKey') {
        logger.info('Object does not exist, treating delete as successful', { key, s3Bucket: config.bucket, tenant });
        return { ok: true, value: undefined };
      }

      const ryError = mapAWSErrorToRyError(error, 'deleteObject', {
        s3Bucket: config.bucket,
        tenant,
        key
      });
      return { ok: false, error: ryError };
    }
  };

  const deleteObjectsByPrefix: ObjectStorageService['deleteObjectsByPrefix'] = async ({ tenant, prefix }: { tenant: string; prefix?: string }) => {
    const s3Prefix = tenantKey(tenant, prefix || '');
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
          { s3Bucket: config.bucket, tenant, prefix: prefix || 'all' }
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
          { s3Bucket: config.bucket, tenant, batchSize: String(keys.length) }
        );

        totalDeleted += keys.length;
        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (continuationToken);

      return { ok: true, value: { deleted: totalDeleted } };
    } catch (error) {
      const ryError = mapAWSErrorToRyError(error, 'deleteObjectsByPrefix', {
        s3Bucket: config.bucket,
        tenant,
        prefix: prefix || 'all',
      });
      return { ok: false, error: ryError };
    }
  };

  const getPublicUrl: ObjectStorageService['getPublicUrl'] = ({ tenant, key }) => {
    return `${config.publicEndpoint}/tenant/${tenant}/${key}`;
  };

  const getObjectData: ObjectStorageService['getObjectData'] = async ({ tenant, key }: { tenant: string; key: string }) => {
    try {
      const result = await withRetry(
        () => client.send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: tenantKey(tenant, key),
        })),
        'getObjectData',
        isRetryableError,
        { s3Bucket: config.bucket, tenant, key }
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
      const ryError = mapAWSErrorToRyError(error, 'getObjectData', { s3Bucket: config.bucket, tenant, key });
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
