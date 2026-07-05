import { describe, test, expect } from 'vitest';
import { createPicsumObjectStorageService } from './PicsumObjectStorageService';

describe('PicsumObjectStorageService', () => {
  const testNamespace = 'test-namespace';

  test('should create a service', () => {
    const service = createPicsumObjectStorageService({});
    expect(service).toBeDefined();
    expect(service.getPublicUrl).toBeDefined();
    expect(service.uploadObject).toBeDefined();
    expect(service.listObjects).toBeDefined();
  });

  test('should generate consistent Picsum URLs for the same key', async () => {
    const service = createPicsumObjectStorageService({});

    const url1 = service.getPublicUrl({ namespace: testNamespace, key: 'image1.jpg' });
    const url2 = service.getPublicUrl({ namespace: testNamespace, key: 'image1.jpg' });

    expect(url1).toBe(url2);
    expect(url1).toContain('picsum.photos');
  });

  test('should generate different URLs for different keys', async () => {
    const service = createPicsumObjectStorageService({});

    const url1 = service.getPublicUrl({ namespace: testNamespace, key: 'image1.jpg' });
    const url2 = service.getPublicUrl({ namespace: testNamespace, key: 'image2.jpg' });

    expect(url1).not.toBe(url2);
  });

  test('should upload objects to buckets', async () => {
    const service = createPicsumObjectStorageService({});

    const body = new Uint8Array([1, 2, 3, 4]);
    const result = await service.uploadObject({
      namespace: testNamespace,
      key: 'test.jpg',
      body,
      metadata: { contentType: 'image/jpeg' },
    });

    expect(result.ok).toBe(true);
  });

  test('should list objects in a bucket', async () => {
    const service = createPicsumObjectStorageService({});

    const body = new Uint8Array([1, 2, 3, 4]);
    await service.uploadObject({
      namespace: testNamespace,
      key: 'image1.jpg',
      body,
    });
    await service.uploadObject({
      namespace: testNamespace,
      key: 'image2.jpg',
      body,
    });

    const result = await service.listObjects({
      namespace: testNamespace,
      includeHead: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objects).toHaveLength(2);
      expect(result.value.objects.map(o => o.key)).toContain('image1.jpg');
      expect(result.value.objects.map(o => o.key)).toContain('image2.jpg');
    }
  });

  test('should list objects with metadata when includeHead is true', async () => {
    const service = createPicsumObjectStorageService({});

    const body = new Uint8Array([1, 2, 3, 4]);
    await service.uploadObject({
      namespace: testNamespace,
      key: 'image1.jpg',
      body,
      metadata: {
        contentType: 'image/jpeg',
        width: '1024',
        height: '768',
      },
    });

    const result = await service.listObjects({
      namespace: testNamespace,
      includeHead: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objects).toHaveLength(1);
      const obj = result.value.objects[0];
      expect(obj).toBeDefined();
      expect(obj?.key).toBe('image1.jpg');
      expect(obj && 'metadata' in obj).toBe(true);
      expect(obj && 'contentType' in obj).toBe(true);
    }
  });

  test('should filter objects by prefix', async () => {
    const service = createPicsumObjectStorageService({});

    const body = new Uint8Array([1, 2, 3, 4]);
    await service.uploadObject({ namespace: testNamespace, key: 'photos/image1.jpg', body });
    await service.uploadObject({ namespace: testNamespace, key: 'photos/image2.jpg', body });
    await service.uploadObject({ namespace: testNamespace, key: 'documents/file.pdf', body });

    const result = await service.listObjects({
      namespace: testNamespace,
      prefix: 'photos/',
      includeHead: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objects).toHaveLength(2);
      expect(result.value.objects.every(o => o.key.startsWith('photos/'))).toBe(true);
    }
  });

  test('should delete objects from bucket', async () => {
    const service = createPicsumObjectStorageService({});

    const body = new Uint8Array([1, 2, 3, 4]);
    await service.uploadObject({
      namespace: testNamespace,
      key: 'image1.jpg',
      body,
    });

    const deleteResult = await service.deleteObject({
      namespace: testNamespace,
      key: 'image1.jpg',
    });

    expect(deleteResult.ok).toBe(true);

    const listResult = await service.listObjects({
      namespace: testNamespace,
      includeHead: false,
    });

    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.objects).toHaveLength(0);
    }
  });

  test('should handle delete of non-existent object gracefully', async () => {
    const service = createPicsumObjectStorageService({});

    // Upload first to ensure bucket exists
    await service.uploadObject({
      namespace: testNamespace,
      key: 'dummy.jpg',
      body: new Uint8Array([1, 2, 3, 4]),
    });

    const result = await service.deleteObject({
      namespace: testNamespace,
      key: 'non-existent.jpg',
    });

    expect(result.ok).toBe(true);
  });

  test('should return error for listing objects in non-existent namespace', async () => {
    const service = createPicsumObjectStorageService({});

    const result = await service.listObjects({
      namespace: 'non-existent-namespace',
      includeHead: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('not_found_bucket');
      expect(result.error.message).toBe("Storage namespace 'non-existent-namespace' not found");
    }
  });

  test('should report the root namespace as (root) in the not-found message', async () => {
    const service = createPicsumObjectStorageService({});

    const result = await service.listObjects({ includeHead: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('not_found_bucket');
      expect(result.error.message).toBe("Storage namespace '(root)' not found");
    }
  });

  test('should store objects in the root namespace when namespace is omitted', async () => {
    const service = createPicsumObjectStorageService({});

    const body = new Uint8Array([1, 2, 3, 4]);
    await service.uploadObject({ key: 'root-image.jpg', body });

    const result = await service.listObjects({ includeHead: false });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objects).toHaveLength(1);
      expect(result.value.objects.map(o => o.key)).toContain('root-image.jpg');
    }
  });

  test('should isolate the root namespace from named namespaces', async () => {
    const service = createPicsumObjectStorageService({});

    const body = new Uint8Array([1, 2, 3, 4]);
    await service.uploadObject({ key: 'root-only.jpg', body });
    await service.uploadObject({ namespace: testNamespace, key: 'ns-only.jpg', body });

    const rootList = await service.listObjects({ includeHead: false });
    const nsList = await service.listObjects({ namespace: testNamespace, includeHead: false });

    expect(rootList.ok && nsList.ok).toBe(true);
    if (rootList.ok && nsList.ok) {
      expect(rootList.value.objects.map(o => o.key)).toEqual(['root-only.jpg']);
      expect(nsList.value.objects.map(o => o.key)).toEqual(['ns-only.jpg']);
    }
  });

  test('should use custom dimensions from metadata', async () => {
    const service = createPicsumObjectStorageService({
      defaultDimensions: { width: 800, height: 600 },
    });

    const body = new Uint8Array([1, 2, 3, 4]);
    await service.uploadObject({
      namespace: testNamespace,
      key: 'large-image.jpg',
      body,
      metadata: {
        width: '1920',
        height: '1080',
      },
    });

    const url = service.getPublicUrl({ namespace: testNamespace, key: 'large-image.jpg' });

    expect(url).toContain('1920');
    expect(url).toContain('1080');
  });

  test('should use custom query from metadata', async () => {
    const service = createPicsumObjectStorageService({});

    const body = new Uint8Array([1, 2, 3, 4]);
    await service.uploadObject({
      namespace: testNamespace,
      key: 'beach.jpg',
      body,
      metadata: {
        query: 'beach,ocean,tropical',
      },
    });

    const url = service.getPublicUrl({ namespace: testNamespace, key: 'beach.jpg' });

    expect(url).toContain('picsum.photos');
  });

  test('should support custom base URL', async () => {
    const service = createPicsumObjectStorageService({
      baseUrl: 'https://custom.picsum.com',
    });

    // Upload to initialize bucket
    await service.uploadObject({
      namespace: testNamespace,
      key: 'image.jpg',
      body: new Uint8Array([1, 2, 3, 4]),
    });

    const url = service.getPublicUrl({ namespace: testNamespace, key: 'image.jpg' });

    expect(url).toContain('custom.picsum.com');
  });
});
