import { describe, test, expect, vi } from 'vitest';
import { createPostgresObjectStorageService, type StorageDrizzle } from './PostgresObjectStorageService';

/**
 * Minimal fake drizzle instance. Only the query-builder chains this provider
 * actually uses are stubbed; `transaction` records the SQL executed inside the
 * bootstrap DDL transaction so tests can assert on lock ids / DDL presence.
 */
const makeFakeDb = (options?: { deletedRows?: Array<{ id: number }> }) => {
  const executedSql: unknown[] = [];
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({
      execute: async (query: unknown) => {
        executedSql.push(query);
      },
    });
  });
  const select = vi.fn(() => ({
    from: () => ({
      where: () => Object.assign(
        // listObjects awaits .orderBy(...); getObjectData awaits .limit(1)
        Promise.resolve([]),
        {
          limit: async () => [],
          orderBy: async () => [],
        }
      ),
    }),
  }));
  const del = vi.fn(() => ({
    where: () => ({
      returning: async () => options?.deletedRows ?? [],
    }),
  }));

  const db = { transaction, select, delete: del } as unknown as StorageDrizzle;
  return { db, transaction, select, delete: del, executedSql };
};

/**
 * Recursively collect bound parameter values from a drizzle SQL object.
 * Parameters appear either as raw primitives in `queryChunks` or wrapped in a
 * `Param` object with a primitive `value`; `StringChunk`s carry a string[]
 * `value` and are skipped.
 */
const collectParamValues = (node: unknown, out: unknown[] = [], depth = 0): unknown[] => {
  if (depth > 6) return out;
  if (typeof node === 'number' || typeof node === 'string' || typeof node === 'boolean') {
    out.push(node);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  const value = record.value;
  if ('value' in record && (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')) {
    out.push(value);
  }
  const children = record.queryChunks;
  if (Array.isArray(children)) {
    for (const child of children) collectParamValues(child, out, depth + 1);
  }
  return out;
};

const createPublicUrl = (namespace: string | undefined, key: string) =>
  `https://cdn.example.com/${namespace ?? ''}/${key}`;

describe('PostgresObjectStorageService (mocked drizzle)', () => {
  describe('deleteObjectsByPrefix prefix guard', () => {
    test('rejects a missing prefix without touching the database', async () => {
      const { db, transaction, delete: del } = makeFakeDb();
      const service = createPostgresObjectStorageService({ drizzle: db, createPublicUrl });

      const result = await service.deleteObjectsByPrefix({ namespace: 'n1' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('invalid_prefix');
      }
      expect(transaction).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    });

    test('rejects an empty prefix without touching the database', async () => {
      const { db, delete: del } = makeFakeDb();
      const service = createPostgresObjectStorageService({ drizzle: db, createPublicUrl });

      const result = await service.deleteObjectsByPrefix({ namespace: 'n1', prefix: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('invalid_prefix');
      }
      expect(del).not.toHaveBeenCalled();
    });

    test('deletes and counts when a real prefix is given', async () => {
      const { db, delete: del } = makeFakeDb({ deletedRows: [{ id: 1 }, { id: 2 }] });
      const service = createPostgresObjectStorageService({ drizzle: db, createPublicUrl });

      const result = await service.deleteObjectsByPrefix({ namespace: 'n1', prefix: 'a/' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.deleted).toBe(2);
      }
      expect(del).toHaveBeenCalledTimes(1);
    });
  });

  describe('table initializer options', () => {
    test('autoCreateTable: false skips all runtime DDL', async () => {
      const { db, transaction } = makeFakeDb();
      const service = createPostgresObjectStorageService({
        drizzle: db,
        createPublicUrl,
        autoCreateTable: false,
      });

      const result = await service.getObjectData({ namespace: 'n1', key: 'missing.txt' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('not_found');
      }
      expect(transaction).not.toHaveBeenCalled();
    });

    test('DDL bootstrap runs by default (once) and uses the default advisory lock id', async () => {
      const { db, transaction, executedSql } = makeFakeDb();
      const service = createPostgresObjectStorageService({ drizzle: db, createPublicUrl });

      await service.getObjectData({ namespace: 'n1', key: 'a.txt' });
      await service.getObjectData({ namespace: 'n1', key: 'b.txt' });

      expect(transaction).toHaveBeenCalledTimes(1);
      const params = collectParamValues(executedSql[0]);
      expect(params).toContain(123456789);
    });

    test('a custom advisoryLockId is used for the bootstrap lock', async () => {
      const { db, executedSql } = makeFakeDb();
      const service = createPostgresObjectStorageService({
        drizzle: db,
        createPublicUrl,
        advisoryLockId: 424242,
      });

      await service.getObjectData({ namespace: 'n1', key: 'a.txt' });

      const params = collectParamValues(executedSql[0]);
      expect(params).toContain(424242);
      expect(params).not.toContain(123456789);
    });
  });
});
