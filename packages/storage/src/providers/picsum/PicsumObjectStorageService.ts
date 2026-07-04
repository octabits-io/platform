import type { ObjectStorageService, ObjectStorageUrlProvider } from '../../base/interfaces';
import type { ListObjectsResponse } from '../../base/types';
import type { ObjectStorageError } from '../../base/errors';

/**
 * Configuration for Picsum URL provider (simple, non-tenant-aware version)
 */
export interface PicsumObjectStorageUrlProviderConfig {
  /**
   * Base URL for placeholder image service
   * @default 'https://picsum.photos'
   */
  readonly baseUrl?: string;
  /**
   * Default image dimensions
   * @default { width: 800, height: 600 }
   */
  readonly defaultDimensions?: {
    readonly width: number;
    readonly height: number;
  };
}

export interface PicsumObjectStorageUrlProvider extends ObjectStorageUrlProvider {
  readonly type: 'picsum';
}

/**
 * Generates a consistent seed from a key string
 */
const generateSeedFromKey = (key: string): string => {
  // Simple hash function to generate consistent seed from key
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
};

/**
 * Creates a URL provider for Picsum placeholder images.
 * This is a simple factory function similar to createAWSObjectStorageUrlProvider,
 * useful for client mode with static tenant configuration.
 *
 * Features:
 * - Generates consistent placeholder URLs based on key
 * - Uses picsum.photos seed-based URLs for deterministic images
 * - Tenant parameter is accepted but ignored (picsum uses key-based seeds)
 *
 * @param config - Picsum URL provider configuration
 * @returns ObjectStorageUrlProvider implementation using picsum.photos
 */
export const createPicsumObjectStorageUrlProvider = (config: PicsumObjectStorageUrlProviderConfig): PicsumObjectStorageUrlProvider => {
  const baseUrl = config.baseUrl || 'https://picsum.photos';
  const defaultDimensions = config.defaultDimensions || { width: 800, height: 600 };

  return {
    type: 'picsum' as const,
    getPublicUrl: ({ tenant: _tenant, key }: { tenant: string; key: string }) => {
      const seed = generateSeedFromKey(key);
      // Format: https://picsum.photos/seed/{SEED}/{WIDTH}/{HEIGHT}
      return `${baseUrl}/seed/${seed}/${defaultDimensions.width}/${defaultDimensions.height}`;
    },
  };
};

/**
 * Configuration for Picsum-based object storage mock service
 */
export interface PicsumObjectStorageServiceConfig {
  /**
   * Picsum API access key (optional - not required for picsum.photos)
   */
  readonly accessKey?: string;
  /**
   * Base URL for placeholder image service
   * @default 'https://picsum.photos'
   */
  readonly baseUrl?: string;
  /**
   * Default image dimensions
   * @default { width: 800, height: 600 }
   */
  readonly defaultDimensions?: {
    readonly width: number;
    readonly height: number;
  };
  /**
   * Default search query for random images (not used with picsum.photos)
   * @default 'property,real-estate,house,apartment'
   */
  readonly defaultQuery?: string;
}

interface MockBucket {
  readonly name: string;
  readonly objects: Map<string, MockObject>;
}

interface MockObject {
  readonly key: string;
  readonly size: number;
  readonly metadata: Record<string, string>;
  readonly contentType: string;
  readonly picsumSeed: string; // Seed for consistent random images
}

export interface PicsumObjectStorageService extends ObjectStorageService {
  readonly type: 'picsum';
}

/**
 * Creates a mock object storage service that uses placeholder images for image URLs.
 * This is useful for development/testing without needing actual object storage.
 * Uses picsum.photos for reliable placeholder images.
 *
 * Features:
 * - Generates consistent placeholder URLs based on key/tenant combinations
 * - Simulates tenant and object management in-memory
 * - Supports all ObjectStorageService operations
 * - Returns realistic image URLs from picsum.photos
 *
 * @param config - Picsum service configuration
 * @returns ObjectStorageService implementation using placeholder images
 */
export const createPicsumObjectStorageService = (config: PicsumObjectStorageServiceConfig): PicsumObjectStorageService => {
  const baseUrl = config.baseUrl || 'https://picsum.photos';
  const defaultDimensions = config.defaultDimensions || { width: 800, height: 600 };

  // In-memory storage for buckets and their objects
  const buckets = new Map<string, MockBucket>();

  /**
   * Gets or creates a bucket
   */
  const getOrCreateBucket = (bucketName: string): MockBucket => {
    let bucketData = buckets.get(bucketName);
    if (!bucketData) {
      bucketData = {
        name: bucketName,
        objects: new Map(),
      };
      buckets.set(bucketName, bucketData);
    }
    return bucketData;
  };

  const getPublicUrl: ObjectStorageService['getPublicUrl'] = ({ tenant, key }) => {
    const bucketData = buckets.get(tenant);
    const obj = bucketData?.objects.get(key);

    let width = defaultDimensions.width;
    let height = defaultDimensions.height;

    if (obj?.metadata) {
      width = Number.parseInt(obj.metadata.width || String(width), 10);
      height = Number.parseInt(obj.metadata.height || String(height), 10);
    }

    const seed = obj?.picsumSeed || generateSeedFromKey(key);
    return `${baseUrl}/seed/${seed}/${width}/${height}`;
  };

  const listObjects: ObjectStorageService['listObjects'] = async <T extends boolean>({ tenant, prefix, includeHead }: {
    tenant: string;
    prefix?: string;
    includeHead: T;
  }) => {
    const bucketData = buckets.get(tenant);

    if (!bucketData) {
      return {
        ok: false,
        error: {
          key: 'not_found_bucket',
          message: `Tenant storage '${tenant}' not found`,
        } as ObjectStorageError,
      };
    }

    let objects = Array.from(bucketData.objects.values());

    // Filter by prefix if provided
    if (prefix) {
      objects = objects.filter(obj => obj.key.startsWith(prefix!));
    }

    if (includeHead) {
      const objectsWithHead = objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        metadata: obj.metadata,
        contentType: obj.contentType,
      }));

      return {
        ok: true,
        value: {
          continuationToken: undefined,
          objects: objectsWithHead as unknown,
        } as ListObjectsResponse<T>,
      };
    }

    const simpleObjects = objects.map(obj => ({
      key: obj.key,
      size: obj.size,
    }));

    return {
      ok: true,
      value: {
        continuationToken: undefined,
        objects: simpleObjects as unknown,
      } as ListObjectsResponse<T>,
    };
  };

  const uploadObject: ObjectStorageService['uploadObject'] = async ({ tenant, key, metadata, body }: {
    tenant: string;
    key: string;
    metadata?: { readonly [key: string]: string };
    body: Uint8Array | ReadableStream<Uint8Array>;
  }) => {
    const bucketData = getOrCreateBucket(tenant);

    // Calculate approximate size from body
    let size = 0;
    if (body instanceof Uint8Array) {
      size = body.length;
    } else {
      // For ReadableStream, estimate size (in real scenario we'd read it)
      size = 1024; // Default mock size
    }

    // Store object metadata
    const mockObject: MockObject = {
      key,
      size,
      metadata: metadata ? { ...metadata } : {},
      contentType: metadata?.contentType || 'image/jpeg',
      picsumSeed: generateSeedFromKey(key),
    };

    bucketData.objects.set(key, mockObject);

    return { ok: true, value: undefined };
  };

  const deleteObject: ObjectStorageService['deleteObject'] = async ({ tenant, key }: { tenant: string; key: string }) => {
    const bucketData = buckets.get(tenant);

    if (!bucketData) {
      // Idempotent delete - treat missing tenant storage as success
      return { ok: true, value: undefined };
    }

    bucketData.objects.delete(key);
    return { ok: true, value: undefined };
  };

  const getObjectData: ObjectStorageService['getObjectData'] = async ({ tenant, key }: { tenant: string; key: string }) => {
    return {
      ok: false,
      error: {
        key: 'internal_error',
        message: `getObjectData is not implemented for Picsum storage service. Tenant: ${tenant}, Key: ${key}`,
      },
    };
  };

  const deleteObjectsByPrefix: ObjectStorageService['deleteObjectsByPrefix'] = async ({ tenant, prefix }: { tenant: string; prefix?: string }) => {
    const bucketData = buckets.get(tenant);
    if (!bucketData) {
      return { ok: true, value: { deleted: 0 } };
    }

    if (!prefix) {
      const deleted = bucketData.objects.size;
      bucketData.objects.clear();
      return { ok: true, value: { deleted } };
    }

    let deleted = 0;
    for (const key of Array.from(bucketData.objects.keys())) {
      if (key.startsWith(prefix)) {
        bucketData.objects.delete(key);
        deleted++;
      }
    }
    return { ok: true, value: { deleted } };
  };

  return {
    type: 'picsum' as const,
    getPublicUrl,
    listObjects,
    uploadObject,
    deleteObject,
    deleteObjectsByPrefix,
    getObjectData,
  };
};
