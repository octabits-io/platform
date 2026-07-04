import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@octabits-io/foundation/logger';

// --- Mock @aws-sdk/client-s3 (no network) ----------------------------------
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(public readonly config: unknown) {}
    send(command: unknown) {
      return sendMock(command);
    }
  }
  class Command {
    constructor(public readonly input: any) {}
  }
  class PutObjectCommand extends Command {
    readonly _type = 'Put' as const;
  }
  class GetObjectCommand extends Command {
    readonly _type = 'Get' as const;
  }
  class HeadObjectCommand extends Command {
    readonly _type = 'Head' as const;
  }
  class DeleteObjectCommand extends Command {
    readonly _type = 'Delete' as const;
  }
  class DeleteObjectsCommand extends Command {
    readonly _type = 'DeleteObjects' as const;
  }
  class ListObjectsV2Command extends Command {
    readonly _type = 'List' as const;
  }
  return {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
  };
});

// Import AFTER the mock is registered.
import { createAWSObjectStorageService, createAWSObjectStorageUrlProvider } from './AWSObjectStorageService';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

const baseConfig = {
  bucket: 'test-bucket',
  publicEndpoint: 'https://cdn.example.com',
  region: 'eu-central',
  endpoint: 'https://hetzner.example.com',
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
  logger: noopLogger,
};

const TENANT = 't-s3';

describe('AWSObjectStorageService (S3-compatible)', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  test('createAWSObjectStorageUrlProvider builds tenant-prefixed public URLs', () => {
    const provider = createAWSObjectStorageUrlProvider({ publicEndpoint: 'https://cdn.example.com' });
    expect(provider.type).toBe('s3');
    expect(provider.getPublicUrl({ tenant: TENANT, key: 'a/b.jpg' })).toBe(
      'https://cdn.example.com/tenant/t-s3/a/b.jpg'
    );
  });

  test('getPublicUrl uses publicEndpoint and tenant prefix', () => {
    const service = createAWSObjectStorageService(baseConfig);
    expect(service.type).toBe('s3');
    expect(service.getPublicUrl({ tenant: TENANT, key: 'img.png' })).toBe(
      'https://cdn.example.com/tenant/t-s3/img.png'
    );
  });

  test('uploadObject sends a PutObjectCommand with a tenant-prefixed key', async () => {
    sendMock.mockResolvedValue({});
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.uploadObject({
      tenant: TENANT,
      key: 'photos/x.jpg',
      body: new Uint8Array([1, 2, 3]),
      metadata: { author: 'me' },
    });

    expect(result.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0]![0];
    expect(cmd._type).toBe('Put');
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('tenant/t-s3/photos/x.jpg');
    expect(cmd.input.Metadata).toEqual({ author: 'me' });
  });

  test('getObjectData returns decoded bytes + metadata', async () => {
    sendMock.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([72, 105]) }, // "Hi"
      ContentLength: 2,
      ContentType: 'text/plain',
      Metadata: { author: 'me' },
      LastModified: new Date('2026-01-02T03:04:05.000Z'),
    });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.getObjectData({ tenant: TENANT, key: 'f.txt' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data.toString()).toBe('Hi');
      expect(result.value.size).toBe(2);
      expect(result.value.contentType).toBe('text/plain');
      expect(result.value.metadata).toEqual({ author: 'me' });
      expect(result.value.lastModified).toBe('2026-01-02T03:04:05.000Z');
    }
    const cmd = sendMock.mock.calls[0]![0];
    expect(cmd._type).toBe('Get');
    expect(cmd.input.Key).toBe('tenant/t-s3/f.txt');
  });

  test('getObjectData maps NoSuchKey to a typed not_found', async () => {
    sendMock.mockRejectedValue({ name: 'NoSuchKey', message: 'nope' });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.getObjectData({ tenant: TENANT, key: 'missing.txt' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('not_found');
    }
  });

  test('deleteObject treats NoSuchKey as an idempotent success', async () => {
    sendMock.mockRejectedValue({ name: 'NoSuchKey', message: 'nope' });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.deleteObject({ tenant: TENANT, key: 'gone.txt' });
    expect(result.ok).toBe(true);
  });

  test('deleteObject maps AccessDenied to access_denied', async () => {
    sendMock.mockRejectedValue({ name: 'AccessDenied', message: 'denied' });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.deleteObject({ tenant: TENANT, key: 'x.txt' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('access_denied');
    }
  });

  test('listObjects strips the tenant prefix from returned keys', async () => {
    sendMock.mockResolvedValue({
      Contents: [
        { Key: 'tenant/t-s3/a.jpg', Size: 10 },
        { Key: 'tenant/t-s3/sub/b.jpg', Size: 20 },
      ],
      ContinuationToken: undefined,
    });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.listObjects({ tenant: TENANT, includeHead: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objects.map(o => o.key)).toEqual(['a.jpg', 'sub/b.jpg']);
      expect(result.value.objects.map(o => o.size)).toEqual([10, 20]);
    }
    const cmd = sendMock.mock.calls[0]![0];
    expect(cmd._type).toBe('List');
    expect(cmd.input.Prefix).toBe('tenant/t-s3/');
  });

  test('deleteObjectsByPrefix lists then batch-deletes and counts', async () => {
    sendMock.mockImplementation((cmd: any) => {
      if (cmd._type === 'List') {
        return Promise.resolve({
          Contents: [{ Key: 'tenant/t-s3/a' }, { Key: 'tenant/t-s3/b' }],
          IsTruncated: false,
        });
      }
      // DeleteObjects
      return Promise.resolve({});
    });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.deleteObjectsByPrefix({ tenant: TENANT, prefix: 'p/' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deleted).toBe(2);
    }
    const types = sendMock.mock.calls.map(c => c[0]._type);
    expect(types).toContain('List');
    expect(types).toContain('DeleteObjects');
  });
});
