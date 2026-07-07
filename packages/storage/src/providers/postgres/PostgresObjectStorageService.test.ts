import { describe, test, expect } from 'vitest';
import {
  createPostgresObjectStorageService,
  createPostgresObjectStorageUrlProvider,
  objectStorageDdl,
} from './PostgresObjectStorageService';
import type { Pool } from 'pg';

/**
 * A captured query: its SQL text, bound values, and whether it ran on the pool
 * directly (`pool.query`, data ops) or on a checked-out client (`client.query`,
 * the DDL bootstrap transaction).
 */
interface Captured {
  text: string;
  values: unknown[];
  via: 'pool' | 'client';
}

type QueryResult = { rows?: unknown[]; rowCount?: number };
/** Decides what each query returns; matched by SQL text. Default: empty result. */
type Responder = (text: string, values: unknown[]) => QueryResult;

/**
 * Minimal fake `pg` Pool. Captures every query with its origin; an injectable
 * `responder` shapes results by SQL text, and `throwOnClient` lets a bootstrap
 * statement fail so ROLLBACK behavior can be asserted.
 */
const makeFakePool = (opts?: {
  responder?: Responder;
  throwOnClient?: (text: string) => boolean;
}) => {
  const captured: Captured[] = [];
  let connectCount = 0;
  let releaseCount = 0;
  const respond: Responder = (text, values) =>
    opts?.responder?.(text, values) ?? { rows: [], rowCount: 0 };

  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      captured.push({ text, values, via: 'pool' });
      return respond(text, values);
    },
    connect: async () => {
      connectCount++;
      return {
        query: async (text: string, values: unknown[] = []) => {
          captured.push({ text, values, via: 'client' });
          if (opts?.throwOnClient?.(text)) {
            throw Object.assign(new Error(`boom: ${text.slice(0, 20)}`), { code: 'XXXXX' });
          }
          return respond(text, values);
        },
        release: () => {
          releaseCount++;
        },
      };
    },
  } as unknown as Pool;

  return {
    pool,
    captured,
    get connectCount() {
      return connectCount;
    },
    get releaseCount() {
      return releaseCount;
    },
  };
};

const createPublicUrl = (namespace: string | undefined, key: string) =>
  `https://cdn.example.com/${namespace ?? ''}/${key}`;

describe('PostgresObjectStorageService (raw pg)', () => {
  describe('deleteObjectsByPrefix prefix guard', () => {
    test('rejects a missing prefix without touching the database', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({ pool: fake.pool, createPublicUrl });

      const result = await service.deleteObjectsByPrefix({ namespace: 'n1' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('invalid_prefix');
      expect(fake.captured).toHaveLength(0);
      expect(fake.connectCount).toBe(0);
    });

    test('rejects an empty prefix without touching the database', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({ pool: fake.pool, createPublicUrl });

      const result = await service.deleteObjectsByPrefix({ namespace: 'n1', prefix: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('invalid_prefix');
      expect(fake.captured).toHaveLength(0);
    });

    test('counts deletions from rowCount when a real prefix is given', async () => {
      const fake = makeFakePool({
        responder: (text) => (text.includes('DELETE') ? { rowCount: 3 } : { rows: [], rowCount: 0 }),
      });
      const service = createPostgresObjectStorageService({
        pool: fake.pool,
        createPublicUrl,
        autoCreateTable: false,
      });

      const result = await service.deleteObjectsByPrefix({ namespace: 'n1', prefix: 'a/' });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.deleted).toBe(3);
      const del = fake.captured.find((c) => c.text.includes('DELETE'));
      expect(del?.values).toEqual(['n1', 'a/%']);
      expect(del?.text).toContain('key LIKE $2');
    });
  });

  describe('table initializer', () => {
    test('autoCreateTable: false skips all runtime DDL (connect never called)', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({
        pool: fake.pool,
        createPublicUrl,
        autoCreateTable: false,
      });

      const result = await service.getObjectData({ namespace: 'n1', key: 'missing.txt' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('not_found');
      expect(fake.connectCount).toBe(0);
      expect(fake.captured.every((c) => c.via === 'pool')).toBe(true);
    });

    test('DDL bootstrap runs once (memoized) with the default advisory lock id', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({ pool: fake.pool, createPublicUrl });

      await service.getObjectData({ namespace: 'n1', key: 'a.txt' });
      await service.getObjectData({ namespace: 'n1', key: 'b.txt' });

      expect(fake.connectCount).toBe(1);
      const lock = fake.captured.find((c) => c.text.includes('pg_advisory_xact_lock'));
      expect(lock?.via).toBe('client');
      expect(lock?.values).toEqual([123456789]);
    });

    test('a custom advisoryLockId is used for the bootstrap lock', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({
        pool: fake.pool,
        createPublicUrl,
        advisoryLockId: 424242,
      });

      await service.getObjectData({ namespace: 'n1', key: 'a.txt' });

      const lock = fake.captured.find((c) => c.text.includes('pg_advisory_xact_lock'));
      expect(lock?.values).toEqual([424242]);
      expect(lock?.values).not.toContain(123456789);
    });

    test('bootstrap runs BEGIN…COMMIT in a transaction and releases the client', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({ pool: fake.pool, createPublicUrl });

      await service.getObjectData({ namespace: 'n1', key: 'a.txt' });

      const clientTexts = fake.captured.filter((c) => c.via === 'client').map((c) => c.text.trim());
      expect(clientTexts[0]).toBe('BEGIN');
      expect(clientTexts).toContain('COMMIT');
      expect(clientTexts).not.toContain('ROLLBACK');
      // CREATE TABLE + rename + 2 indexes + unique constraint all inside the tx.
      expect(clientTexts.some((t) => t.includes('CREATE TABLE IF NOT EXISTS object_storage'))).toBe(true);
      expect(fake.releaseCount).toBe(1);
    });

    test('a failing bootstrap statement rolls back, releases, and surfaces internal_error', async () => {
      const fake = makeFakePool({ throwOnClient: (text) => text.includes('CREATE TABLE') });
      const service = createPostgresObjectStorageService({ pool: fake.pool, createPublicUrl });

      const result = await service.getObjectData({ namespace: 'n1', key: 'a.txt' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('internal_error');
      const clientTexts = fake.captured.filter((c) => c.via === 'client').map((c) => c.text.trim());
      expect(clientTexts).toContain('ROLLBACK');
      expect(clientTexts).not.toContain('COMMIT');
      expect(fake.releaseCount).toBe(1);
    });
  });

  describe('uploadObject', () => {
    test('issues a single (namespace, key) upsert', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({
        pool: fake.pool,
        createPublicUrl,
        autoCreateTable: false,
      });

      const result = await service.uploadObject({
        namespace: 'n1',
        key: 'docs/f.pdf',
        metadata: { 'content-type': 'application/pdf' },
        body: new Uint8Array([1, 2, 3, 4, 5]),
      });

      expect(result.ok).toBe(true);
      const inserts = fake.captured.filter((c) => c.text.includes('INSERT INTO object_storage'));
      expect(inserts).toHaveLength(1);
      const insert = inserts[0]!;
      expect(insert.text).toContain('ON CONFLICT (namespace, key) DO UPDATE');
      expect(insert.text).toContain('updated_at = NOW()');
      // namespace, key, buffer, size, contentType, metadata-json
      expect(insert.values[0]).toBe('n1');
      expect(insert.values[1]).toBe('docs/f.pdf');
      expect(insert.values[3]).toBe(5); // size
      expect(insert.values[4]).toBe('application/pdf');
      expect(insert.values[5]).toBe(JSON.stringify({ 'content-type': 'application/pdf' }));
    });
  });

  describe('getObjectData mapping', () => {
    test('maps a raw pg row (bigint string → number, Date → ISO string)', async () => {
      const updatedAt = new Date('2026-01-02T03:04:05.000Z');
      const fake = makeFakePool({
        responder: (text) =>
          text.includes('SELECT data')
            ? {
                rows: [
                  {
                    data: Buffer.from('hello'),
                    size: '5',
                    content_type: 'text/plain',
                    metadata: { a: 'b' },
                    updated_at: updatedAt,
                  },
                ],
              }
            : { rows: [], rowCount: 0 },
      });
      const service = createPostgresObjectStorageService({
        pool: fake.pool,
        createPublicUrl,
        autoCreateTable: false,
      });

      const result = await service.getObjectData({ namespace: 'n1', key: 'a.txt' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(5);
        expect(typeof result.value.size).toBe('number');
        expect(result.value.contentType).toBe('text/plain');
        expect(result.value.metadata).toEqual({ a: 'b' });
        expect(result.value.lastModified).toBe('2026-01-02T03:04:05.000Z');
        expect(typeof result.value.lastModified).toBe('string');
      }
      const select = fake.captured.find((c) => c.text.includes('SELECT data'));
      expect(select?.text).toContain('LIMIT 1');
      expect(select?.values).toEqual(['n1', 'a.txt']);
    });

    test('returns not_found on zero rows', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({
        pool: fake.pool,
        createPublicUrl,
        autoCreateTable: false,
      });

      const result = await service.getObjectData({ key: 'missing.txt' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('not_found');
    });
  });

  describe('listObjects param shapes', () => {
    test('without a prefix filters by namespace only', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({
        pool: fake.pool,
        createPublicUrl,
        autoCreateTable: false,
      });

      await service.listObjects({ namespace: 'n1', includeHead: false });

      const select = fake.captured.find((c) => c.text.includes('SELECT key'));
      expect(select?.values).toEqual(['n1']);
      expect(select?.text).not.toContain('LIKE');
      expect(select?.text).toContain('ORDER BY key');
    });

    test('with a prefix adds a key LIKE bound param', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({
        pool: fake.pool,
        createPublicUrl,
        autoCreateTable: false,
      });

      await service.listObjects({ namespace: 'n1', prefix: 'a/', includeHead: true });

      const select = fake.captured.find((c) => c.text.includes('SELECT key'));
      expect(select?.values).toEqual(['n1', 'a/%']);
      expect(select?.text).toContain('key LIKE $2');
    });

    test('roots the empty namespace to the `` sentinel', async () => {
      const fake = makeFakePool();
      const service = createPostgresObjectStorageService({
        pool: fake.pool,
        createPublicUrl,
        autoCreateTable: false,
      });

      await service.listObjects({ includeHead: false });

      const select = fake.captured.find((c) => c.text.includes('SELECT key'));
      expect(select?.values).toEqual(['']);
    });
  });

  describe('url provider parity', () => {
    test('builds URLs and reads object data the same way as the full service', async () => {
      const updatedAt = new Date('2026-01-02T03:04:05.000Z');
      const fake = makeFakePool({
        responder: (text) =>
          text.includes('SELECT data')
            ? {
                rows: [
                  {
                    data: Buffer.from('x'),
                    size: '1',
                    content_type: 'text/plain',
                    metadata: null,
                    updated_at: updatedAt,
                  },
                ],
              }
            : { rows: [], rowCount: 0 },
      });
      const provider = createPostgresObjectStorageUrlProvider({
        pool: fake.pool,
        createPublicUrl,
        autoCreateTable: false,
      });

      expect(provider.type).toBe('postgres');
      expect(provider.getPublicUrl({ namespace: 'n1', key: 'a.txt' })).toBe(
        'https://cdn.example.com/n1/a.txt',
      );

      const result = await provider.getObjectData!({ namespace: 'n1', key: 'a.txt' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(1);
        expect(result.value.metadata).toEqual({});
        expect(result.value.lastModified).toBe('2026-01-02T03:04:05.000Z');
      }
    });
  });

  describe('objectStorageDdl', () => {
    test('emits table, indexes, and the upsert unique constraint, but no legacy tenant_id', () => {
      const ddl = objectStorageDdl();

      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS object_storage');
      expect(ddl).toContain('object_storage_namespace_key_idx');
      expect(ddl).toContain('object_storage_namespace_idx');
      expect(ddl).toContain('object_storage_namespace_key_unique');
      expect(ddl).toContain('UNIQUE (namespace, key)');
      expect(ddl).not.toContain('tenant_id');
    });
  });
});
