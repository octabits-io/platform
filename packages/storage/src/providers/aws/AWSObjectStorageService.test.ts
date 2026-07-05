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

const NAMESPACE = 'n-s3';

// Reproduces the legacy `tenant/<ns>/` object layout for callers migrating off
// the old tenant-prefixed scheme.
const legacyNamespacePrefix = (ns: string) => `tenant/${ns}/`;

describe('AWSObjectStorageService (S3-compatible)', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  test('createAWSObjectStorageUrlProvider builds namespace-prefixed public URLs', () => {
    const provider = createAWSObjectStorageUrlProvider({ publicEndpoint: 'https://cdn.example.com' });
    expect(provider.type).toBe('s3');
    expect(provider.getPublicUrl({ namespace: NAMESPACE, key: 'a/b.jpg' })).toBe(
      'https://cdn.example.com/n-s3/a/b.jpg'
    );
  });

  test('createAWSObjectStorageUrlProvider omits the prefix when namespace is omitted', () => {
    const provider = createAWSObjectStorageUrlProvider({ publicEndpoint: 'https://cdn.example.com' });
    expect(provider.getPublicUrl({ key: 'a/b.jpg' })).toBe('https://cdn.example.com/a/b.jpg');
  });

  test('createAWSObjectStorageUrlProvider honors a custom namespacePrefix (legacy layout)', () => {
    const provider = createAWSObjectStorageUrlProvider({
      publicEndpoint: 'https://cdn.example.com',
      namespacePrefix: legacyNamespacePrefix,
    });
    expect(provider.getPublicUrl({ namespace: NAMESPACE, key: 'a/b.jpg' })).toBe(
      'https://cdn.example.com/tenant/n-s3/a/b.jpg'
    );
  });

  test('getPublicUrl uses publicEndpoint and namespace prefix', () => {
    const service = createAWSObjectStorageService(baseConfig);
    expect(service.type).toBe('s3');
    expect(service.getPublicUrl({ namespace: NAMESPACE, key: 'img.png' })).toBe(
      'https://cdn.example.com/n-s3/img.png'
    );
  });

  test('getPublicUrl omits the prefix when namespace is omitted (single-tenant)', () => {
    const service = createAWSObjectStorageService(baseConfig);
    expect(service.getPublicUrl({ key: 'img.png' })).toBe('https://cdn.example.com/img.png');
  });

  test('uploadObject sends a PutObjectCommand with a namespace-prefixed key', async () => {
    sendMock.mockResolvedValue({});
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.uploadObject({
      namespace: NAMESPACE,
      key: 'photos/x.jpg',
      body: new Uint8Array([1, 2, 3]),
      metadata: { author: 'me' },
    });

    expect(result.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0]![0];
    expect(cmd._type).toBe('Put');
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('n-s3/photos/x.jpg');
    expect(cmd.input.Metadata).toEqual({ author: 'me' });
  });

  test('uploadObject writes an unprefixed key when namespace is omitted', async () => {
    sendMock.mockResolvedValue({});
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.uploadObject({
      key: 'photos/x.jpg',
      body: new Uint8Array([1, 2, 3]),
    });

    expect(result.ok).toBe(true);
    const cmd = sendMock.mock.calls[0]![0];
    expect(cmd.input.Key).toBe('photos/x.jpg');
  });

  test('uploadObject honors a custom namespacePrefix (legacy tenant layout)', async () => {
    sendMock.mockResolvedValue({});
    const service = createAWSObjectStorageService({ ...baseConfig, namespacePrefix: legacyNamespacePrefix });

    const result = await service.uploadObject({
      namespace: NAMESPACE,
      key: 'photos/x.jpg',
      body: new Uint8Array([1, 2, 3]),
    });

    expect(result.ok).toBe(true);
    const cmd = sendMock.mock.calls[0]![0];
    expect(cmd.input.Key).toBe('tenant/n-s3/photos/x.jpg');
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

    const result = await service.getObjectData({ namespace: NAMESPACE, key: 'f.txt' });

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
    expect(cmd.input.Key).toBe('n-s3/f.txt');
  });

  test('getObjectData maps NoSuchKey to a typed not_found', async () => {
    sendMock.mockRejectedValue({ name: 'NoSuchKey', message: 'nope' });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.getObjectData({ namespace: NAMESPACE, key: 'missing.txt' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('not_found');
    }
  });

  test('deleteObject treats NoSuchKey as an idempotent success', async () => {
    sendMock.mockRejectedValue({ name: 'NoSuchKey', message: 'nope' });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.deleteObject({ namespace: NAMESPACE, key: 'gone.txt' });
    expect(result.ok).toBe(true);
  });

  test('deleteObject maps AccessDenied to access_denied', async () => {
    sendMock.mockRejectedValue({ name: 'AccessDenied', message: 'denied' });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.deleteObject({ namespace: NAMESPACE, key: 'x.txt' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('access_denied');
    }
  });

  test('listObjects strips the namespace prefix from returned keys', async () => {
    sendMock.mockResolvedValue({
      Contents: [
        { Key: 'n-s3/a.jpg', Size: 10 },
        { Key: 'n-s3/sub/b.jpg', Size: 20 },
      ],
      ContinuationToken: undefined,
    });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.listObjects({ namespace: NAMESPACE, includeHead: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objects.map(o => o.key)).toEqual(['a.jpg', 'sub/b.jpg']);
      expect(result.value.objects.map(o => o.size)).toEqual([10, 20]);
    }
    const cmd = sendMock.mock.calls[0]![0];
    expect(cmd._type).toBe('List');
    expect(cmd.input.Prefix).toBe('n-s3/');
  });

  test('listObjects lists the whole bucket (no prefix) when namespace is omitted', async () => {
    sendMock.mockResolvedValue({
      Contents: [
        { Key: 'a.jpg', Size: 10 },
        { Key: 'sub/b.jpg', Size: 20 },
      ],
      ContinuationToken: undefined,
    });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.listObjects({ includeHead: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objects.map(o => o.key)).toEqual(['a.jpg', 'sub/b.jpg']);
    }
    const cmd = sendMock.mock.calls[0]![0];
    expect(cmd.input.Prefix).toBe('');
  });

  test('deleteObjectsByPrefix lists then batch-deletes and counts', async () => {
    sendMock.mockImplementation((cmd: any) => {
      if (cmd._type === 'List') {
        return Promise.resolve({
          Contents: [{ Key: 'n-s3/a' }, { Key: 'n-s3/b' }],
          IsTruncated: false,
        });
      }
      // DeleteObjects
      return Promise.resolve({});
    });
    const service = createAWSObjectStorageService(baseConfig);

    const result = await service.deleteObjectsByPrefix({ namespace: NAMESPACE, prefix: 'p/' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deleted).toBe(2);
    }
    const listCmd = sendMock.mock.calls.find(c => c[0]._type === 'List')![0];
    expect(listCmd.input.Prefix).toBe('n-s3/p/');
    const types = sendMock.mock.calls.map(c => c[0]._type);
    expect(types).toContain('List');
    expect(types).toContain('DeleteObjects');
  });
});
