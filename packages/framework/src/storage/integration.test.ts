/**
 * Integration tests for the S3 object-storage provider against a real
 * S3-compatible server (MinIO via testcontainers; Docker required).
 *
 * The provider talks to any S3-compatible store through an explicit
 * `endpoint` + `forcePathStyle`, so MinIO exercises the exact code path
 * production uses against Hetzner Object Storage. Covers the behaviours a
 * mock can't: real content-type round-tripping, `includeHead` HEAD fan-out,
 * namespace key-prefixing, idempotent delete, and prefix bulk-delete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import type { Logger } from '../logger/index.ts';
import { createAWSObjectStorageService, type AWSObjectStorageService } from './s3.ts';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const ACCESS_KEY = 'minioadmin';
const SECRET_KEY = 'minioadmin-secret';
const BUCKET = 'framework-it';

let container: StartedTestContainer;
let storage: AWSObjectStorageService;

beforeAll(async () => {
  container = await new GenericContainer('minio/minio:latest')
    .withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  storage = createAWSObjectStorageService({
    bucket: BUCKET,
    publicEndpoint: `${endpoint}/${BUCKET}`,
    region: 'us-east-1',
    endpoint,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    logger: silentLogger,
  });

  // The provider never creates buckets — it assumes the bucket exists (as it
  // does in production). Create it once via the provider's own S3 client.
  await storage.client.send(new CreateBucketCommand({ Bucket: BUCKET }));
});

afterAll(async () => {
  await container?.stop();
});

const bytes = (s: string) => new TextEncoder().encode(s);

describe('S3 object storage against MinIO', () => {
  it('round-trips bytes and derives content-type from metadata', async () => {
    const up = await storage.uploadObject({
      key: 'docs/readme.txt',
      metadata: { 'content-type': 'text/plain', author: 'ada' },
      body: bytes('hello object storage'),
    });
    expect(up.ok).toBe(true);

    const got = await storage.getObjectData({ key: 'docs/readme.txt' });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.data.toString('utf8')).toBe('hello object storage');
      expect(got.value.contentType).toBe('text/plain');
      expect(got.value.metadata.author).toBe('ada');
      expect(got.value.size).toBe('hello object storage'.length);
    }
  });

  it('falls back to application/octet-stream when no content-type metadata is given', async () => {
    await storage.uploadObject({ key: 'blob.bin', body: bytes('\x00\x01\x02') });
    const got = await storage.getObjectData({ key: 'blob.bin' });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.contentType).toBe('application/octet-stream');
  });

  it('lists objects with and without HEAD augmentation', async () => {
    await storage.uploadObject({ key: 'list/a.txt', metadata: { 'content-type': 'text/plain' }, body: bytes('a') });
    await storage.uploadObject({ key: 'list/b.txt', metadata: { 'content-type': 'text/plain' }, body: bytes('bb') });

    const bare = await storage.listObjects({ prefix: 'list/', includeHead: false });
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      const keys = bare.value.objects.map((o) => o.key).sort();
      expect(keys).toEqual(['list/a.txt', 'list/b.txt']);
      // The bare listing carries key + size only.
      expect(bare.value.objects.every((o) => typeof o.size === 'number')).toBe(true);
    }

    const withHead = await storage.listObjects({ prefix: 'list/', includeHead: true });
    expect(withHead.ok).toBe(true);
    if (withHead.ok) {
      expect(withHead.value.objects.every((o) => o.contentType === 'text/plain')).toBe(true);
    }
  });

  it('partitions objects by namespace and strips the prefix on read', async () => {
    await storage.uploadObject({ namespace: 'tenant-a', key: 'file.txt', body: bytes('A') });
    await storage.uploadObject({ namespace: 'tenant-b', key: 'file.txt', body: bytes('B') });

    const a = await storage.getObjectData({ namespace: 'tenant-a', key: 'file.txt' });
    const b = await storage.getObjectData({ namespace: 'tenant-b', key: 'file.txt' });
    if (a.ok) expect(a.value.data.toString('utf8')).toBe('A');
    if (b.ok) expect(b.value.data.toString('utf8')).toBe('B');

    const listA = await storage.listObjects({ namespace: 'tenant-a', includeHead: false });
    expect(listA.ok).toBe(true);
    // Returned keys are namespace-stripped, matching what callers uploaded.
    if (listA.ok) expect(listA.value.objects.map((o) => o.key)).toEqual(['file.txt']);

    // getPublicUrl reflects the namespace prefix in the URL.
    expect(storage.getPublicUrl({ namespace: 'tenant-a', key: 'file.txt' })).toContain('/tenant-a/file.txt');
  });

  it('treats delete as idempotent and surfaces not_found afterwards', async () => {
    await storage.uploadObject({ key: 'temp.txt', body: bytes('bye') });

    const first = await storage.deleteObject({ key: 'temp.txt' });
    expect(first.ok).toBe(true);
    // Deleting an already-absent object still succeeds (idempotent).
    const second = await storage.deleteObject({ key: 'temp.txt' });
    expect(second.ok).toBe(true);

    const got = await storage.getObjectData({ key: 'temp.txt' });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.key).toBe('not_found');
  });

  it('bulk-deletes by prefix but refuses an empty prefix', async () => {
    await storage.uploadObject({ key: 'bulk/1', body: bytes('1') });
    await storage.uploadObject({ key: 'bulk/2', body: bytes('2') });
    await storage.uploadObject({ key: 'keep/1', body: bytes('k') });

    const guard = await storage.deleteObjectsByPrefix({ prefix: '' });
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.error.key).toBe('invalid_prefix');

    const del = await storage.deleteObjectsByPrefix({ prefix: 'bulk/' });
    expect(del.ok).toBe(true);
    if (del.ok) expect(del.value.deleted).toBe(2);

    // Sibling prefix is untouched.
    const keep = await storage.getObjectData({ key: 'keep/1' });
    expect(keep.ok).toBe(true);
  });

  it('rejects path-traversal keys before any network call', async () => {
    const up = await storage.uploadObject({ key: '../escape', body: bytes('x') });
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.error.key).toBe('invalid_key');
  });
});
