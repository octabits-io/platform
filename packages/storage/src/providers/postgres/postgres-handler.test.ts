import { describe, test, expect, beforeEach } from 'vitest';
import {
  getObjectData,
  parseStoragePath,
  isValidObjectKey,
  sanitizeObjectKey,
  createGenericHandler,
} from './postgres-handler';
import type { ObjectFileServer } from '../../base/interfaces';
import type { ObjectData } from '../../base/types';
import type { ObjectStorageError } from '../../base/errors';
import type { Result } from '@octabits-io/foundation/result';

const NAMESPACE = 'n-pg-handler';
const OTHER_NAMESPACE = 'n-pg-handler-2';

/**
 * In-memory ObjectFileServer — exercises the HTTP handler mechanics (ETag, 304,
 * status mapping, header shaping) without a real Postgres. The blob-in-Postgres
 * provider preserves byte-for-byte behavior and is covered by the host app's
 * integration suite; the handler layer only ever consumes the `ObjectFileServer`
 * contract, so an in-memory fake is a faithful and network-free stand-in.
 */
const createMemoryFileServer = () => {
  const store = new Map<string, ObjectData>();
  // `undefined` namespace addresses the root namespace ('').
  const compositeKey = (namespace: string | undefined, key: string) => `${namespace ?? ''}::${key}`;

  const upload = (params: {
    namespace?: string;
    key: string;
    body: Buffer;
    metadata?: Record<string, string>;
  }) => {
    const metadata = params.metadata ?? {};
    const contentType = metadata['content-type'] || metadata['contentType'] || 'application/octet-stream';
    store.set(compositeKey(params.namespace, params.key), {
      data: params.body,
      size: params.body.length,
      contentType,
      metadata,
      lastModified: '2026-01-01T00:00:00.000Z',
    });
  };

  const fileServer: ObjectFileServer = {
    getObjectData: async ({ namespace, key }): Promise<Result<ObjectData, ObjectStorageError>> => {
      const obj = store.get(compositeKey(namespace, key));
      if (!obj) {
        return { ok: false, error: { key: 'not_found', message: `Object not found: ${key}` } };
      }
      return { ok: true, value: obj };
    },
  };

  return { fileServer, upload };
};

describe('ObjectStorageService.postgres.handler', () => {
  let fileServer: ObjectFileServer;
  let upload: ReturnType<typeof createMemoryFileServer>['upload'];

  beforeEach(() => {
    ({ fileServer, upload } = createMemoryFileServer());
  });

  describe('getObjectData', () => {
    test('should retrieve object data', async () => {
      const testData = Buffer.from('Hello, World!');
      upload({
        namespace: NAMESPACE,
        key: 'test/file.txt',
        body: testData,
        metadata: {
          'content-type': 'text/plain',
          'author': 'test',
        },
      });

      const result = await getObjectData(fileServer, {
        namespace: NAMESPACE,
        key: 'test/file.txt',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.found).toBe(true);
        expect(result.value.data?.toString()).toBe('Hello, World!');
        expect(result.value.contentType).toBe('text/plain');
        expect(result.value.size).toBe(testData.length);
        expect(result.value.metadata?.author).toBe('test');
        expect(result.value.etag).toBeDefined();
        expect(result.value.lastModified).toBeDefined();
      }
    });

    test('should return not_found error for non-existent object', async () => {
      const result = await getObjectData(fileServer, {
        namespace: NAMESPACE,
        key: 'non-existent.txt',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('not_found');
        expect(result.error.statusCode).toBe(404);
      }
    });

    test('should generate consistent ETags', async () => {
      const testData = Buffer.from('Test data');
      upload({
        namespace: NAMESPACE,
        key: 'test.txt',
        body: testData,
      });

      const result1 = await getObjectData(fileServer, {
        namespace: NAMESPACE,
        key: 'test.txt',
      });

      const result2 = await getObjectData(fileServer, {
        namespace: NAMESPACE,
        key: 'test.txt',
      });

      expect(result1.ok && result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value.etag).toBe(result2.value.etag);
      }
    });
  });

  describe('createGenericHandler', () => {
    beforeEach(() => {
      const testData = Buffer.from('Generic handler test');
      upload({
        namespace: NAMESPACE,
        key: 'handler/test.txt',
        body: testData,
        metadata: { 'content-type': 'text/plain' },
      });
    });

    test('should serve object with correct headers', async () => {
      const handler = createGenericHandler(fileServer);
      const response = await handler({
        namespace: NAMESPACE,
        key: 'handler/test.txt',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('text/plain');
      expect(response.headers['Content-Length']).toBeDefined();
      expect(response.headers['ETag']).toBeDefined();
      expect(response.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
      expect(response.body.toString()).toBe('Generic handler test');
    });

    test('should return 404 for non-existent object', async () => {
      const handler = createGenericHandler(fileServer);
      const response = await handler({
        namespace: NAMESPACE,
        key: 'non-existent.txt',
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['Content-Type']).toBe('text/plain');
    });

    test('should handle 304 Not Modified with If-None-Match', async () => {
      const handler = createGenericHandler(fileServer);

      // First request to get ETag
      const firstResponse = await handler({
        namespace: NAMESPACE,
        key: 'handler/test.txt',
      });

      expect(firstResponse.statusCode).toBe(200);
      const etag = firstResponse.headers['ETag'];

      // Second request with If-None-Match
      const secondResponse = await handler({
        namespace: NAMESPACE,
        key: 'handler/test.txt',
        headers: {
          'if-none-match': etag,
        },
      });

      expect(secondResponse.statusCode).toBe(304);
      expect(secondResponse.body).toBe('');
    });
  });

  describe('parseStoragePath', () => {
    test('should parse standard storage path', () => {
      const result = parseStoragePath('/storage/images/photo.jpg');
      expect(result.key).toBe('images/photo.jpg');
    });

    test('should parse path with api prefix', () => {
      const result = parseStoragePath('/api/storage/docs/file.pdf');
      expect(result.key).toBe('docs/file.pdf');
    });

    test('should handle paths without prefix', () => {
      const result = parseStoragePath('/folder/file.txt');
      expect(result.key).toBe('folder/file.txt');
    });

    test('should handle nested keys', () => {
      const result = parseStoragePath('/storage/a/b/c/d/file.txt');
      expect(result.key).toBe('a/b/c/d/file.txt');
    });

    test('should return empty for invalid paths', () => {
      expect(parseStoragePath('/storage')).toEqual({});
    });

    test('should handle leading/trailing slashes', () => {
      const result = parseStoragePath('///storage/key///');
      expect(result.key).toBe('key');
    });
  });

  describe('isValidObjectKey', () => {
    test('should accept valid keys', () => {
      expect(isValidObjectKey('file.txt')).toBe(true);
      expect(isValidObjectKey('images/photo.jpg')).toBe(true);
      expect(isValidObjectKey('a/b/c/d.pdf')).toBe(true);
      expect(isValidObjectKey('file-name_123.txt')).toBe(true);
    });

    test('should reject invalid keys', () => {
      expect(isValidObjectKey('')).toBe(false);
      expect(isValidObjectKey('/absolute/path')).toBe(false);
      expect(isValidObjectKey('path/')).toBe(false);
      expect(isValidObjectKey('path/../traversal')).toBe(false);
      expect(isValidObjectKey('double//slash')).toBe(false);
    });
  });

  describe('sanitizeObjectKey', () => {
    test('should remove leading slashes', () => {
      expect(sanitizeObjectKey('/file.txt')).toBe('file.txt');
      expect(sanitizeObjectKey('///file.txt')).toBe('file.txt');
    });

    test('should remove trailing slashes', () => {
      expect(sanitizeObjectKey('file.txt/')).toBe('file.txt');
      expect(sanitizeObjectKey('file.txt///')).toBe('file.txt');
    });

    test('should normalize multiple slashes', () => {
      expect(sanitizeObjectKey('a//b///c')).toBe('a/b/c');
    });

    test('should remove directory traversal patterns', () => {
      expect(sanitizeObjectKey('path/../file.txt')).toBe('path/file.txt');
      expect(sanitizeObjectKey('../../../etc/passwd')).toBe('etc/passwd');
    });

    test('should handle complex cases', () => {
      expect(sanitizeObjectKey('///a//b/../c///')).toBe('a/b/c');
    });
  });

  describe('namespace isolation', () => {
    test('should only return objects for the specified namespace', async () => {
      const data1 = Buffer.from('Namespace 1 data');
      const data2 = Buffer.from('Namespace 2 data');

      upload({ namespace: NAMESPACE, key: 'shared-key.txt', body: data1 });
      upload({ namespace: OTHER_NAMESPACE, key: 'shared-key.txt', body: data2 });

      const result1 = await getObjectData(fileServer, {
        namespace: NAMESPACE,
        key: 'shared-key.txt',
      });

      const result2 = await getObjectData(fileServer, {
        namespace: OTHER_NAMESPACE,
        key: 'shared-key.txt',
      });

      expect(result1.ok && result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value.data?.toString()).toBe('Namespace 1 data');
        expect(result2.value.data?.toString()).toBe('Namespace 2 data');
      }
    });

    test('should not find objects from other namespaces', async () => {
      const result = await getObjectData(fileServer, {
        namespace: 'nonexistent-namespace',
        key: 'non-existent-key.txt',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('not_found');
      }
    });

    test('should serve objects from the root namespace when namespace is omitted', async () => {
      const rootData = Buffer.from('Root namespace data');
      const nsData = Buffer.from('Named namespace data');

      upload({ key: 'shared-key.txt', body: rootData });
      upload({ namespace: NAMESPACE, key: 'shared-key.txt', body: nsData });

      const rootResult = await getObjectData(fileServer, { key: 'shared-key.txt' });
      const nsResult = await getObjectData(fileServer, { namespace: NAMESPACE, key: 'shared-key.txt' });

      expect(rootResult.ok && nsResult.ok).toBe(true);
      if (rootResult.ok && nsResult.ok) {
        expect(rootResult.value.data?.toString()).toBe('Root namespace data');
        expect(nsResult.value.data?.toString()).toBe('Named namespace data');
      }
    });

    test('generic handler defaults to the root namespace when constructed without one', async () => {
      upload({ key: 'root/file.txt', body: Buffer.from('root blob'), metadata: { 'content-type': 'text/plain' } });

      const handler = createGenericHandler(fileServer);
      const response = await handler({ key: 'root/file.txt' });

      expect(response.statusCode).toBe(200);
      expect(response.body.toString()).toBe('root blob');
    });
  });
});
