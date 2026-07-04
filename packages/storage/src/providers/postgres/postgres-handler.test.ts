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

const TENANT_ID = 't-pg-handler';
const OTHER_TENANT_ID = 't-pg-handler-2';

/**
 * In-memory ObjectFileServer — exercises the HTTP handler mechanics (ETag, 304,
 * status mapping, header shaping) without a real Postgres. The blob-in-Postgres
 * provider preserves byte-for-byte behavior and is covered by the host app's
 * integration suite; the handler layer only ever consumes the `ObjectFileServer`
 * contract, so an in-memory fake is a faithful and network-free stand-in.
 */
const createMemoryFileServer = () => {
  const store = new Map<string, ObjectData>();
  const compositeKey = (tenant: string, key: string) => `${tenant}::${key}`;

  const upload = (params: {
    tenant: string;
    key: string;
    body: Buffer;
    metadata?: Record<string, string>;
  }) => {
    const metadata = params.metadata ?? {};
    const contentType = metadata['content-type'] || metadata['contentType'] || 'application/octet-stream';
    store.set(compositeKey(params.tenant, params.key), {
      data: params.body,
      size: params.body.length,
      contentType,
      metadata,
      lastModified: '2026-01-01T00:00:00.000Z',
    });
  };

  const fileServer: ObjectFileServer = {
    getObjectData: async ({ tenant, key }): Promise<Result<ObjectData, ObjectStorageError>> => {
      const obj = store.get(compositeKey(tenant, key));
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
        tenant: TENANT_ID,
        key: 'test/file.txt',
        body: testData,
        metadata: {
          'content-type': 'text/plain',
          'author': 'test',
        },
      });

      const result = await getObjectData(fileServer, {
        tenant: TENANT_ID,
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
        tenant: TENANT_ID,
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
        tenant: TENANT_ID,
        key: 'test.txt',
        body: testData,
      });

      const result1 = await getObjectData(fileServer, {
        tenant: TENANT_ID,
        key: 'test.txt',
      });

      const result2 = await getObjectData(fileServer, {
        tenant: TENANT_ID,
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
        tenant: TENANT_ID,
        key: 'handler/test.txt',
        body: testData,
        metadata: { 'content-type': 'text/plain' },
      });
    });

    test('should serve object with correct headers', async () => {
      const handler = createGenericHandler(fileServer);
      const response = await handler({
        tenant: TENANT_ID,
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
        tenant: TENANT_ID,
        key: 'non-existent.txt',
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['Content-Type']).toBe('text/plain');
    });

    test('should handle 304 Not Modified with If-None-Match', async () => {
      const handler = createGenericHandler(fileServer);

      // First request to get ETag
      const firstResponse = await handler({
        tenant: TENANT_ID,
        key: 'handler/test.txt',
      });

      expect(firstResponse.statusCode).toBe(200);
      const etag = firstResponse.headers['ETag'];

      // Second request with If-None-Match
      const secondResponse = await handler({
        tenant: TENANT_ID,
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

  describe('multi-tenant isolation', () => {
    test('should only return objects for the specified tenant', async () => {
      const data1 = Buffer.from('Tenant 1 data');
      const data2 = Buffer.from('Tenant 2 data');

      upload({ tenant: TENANT_ID, key: 'shared-key.txt', body: data1 });
      upload({ tenant: OTHER_TENANT_ID, key: 'shared-key.txt', body: data2 });

      const result1 = await getObjectData(fileServer, {
        tenant: TENANT_ID,
        key: 'shared-key.txt',
      });

      const result2 = await getObjectData(fileServer, {
        tenant: OTHER_TENANT_ID,
        key: 'shared-key.txt',
      });

      expect(result1.ok && result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value.data?.toString()).toBe('Tenant 1 data');
        expect(result2.value.data?.toString()).toBe('Tenant 2 data');
      }
    });

    test('should not find objects from other tenants', async () => {
      const result = await getObjectData(fileServer, {
        tenant: 'nonexistent-tenant',
        key: 'non-existent-key.txt',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('not_found');
      }
    });
  });
});
