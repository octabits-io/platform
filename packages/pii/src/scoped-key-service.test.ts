import { describe, it, expect, vi } from 'vitest';
import { createScopedKeyService, type ScopedKeyCache, type ScopedKeyDb, type ScopedKeys } from './scoped-key-service.ts';
import type { MasterKeyProvider } from './master-key.ts';

const masterKeyProvider: MasterKeyProvider = {
  encrypt: async (data: Buffer) => ({ ok: true, value: data }),
  decrypt: async (data: Buffer) => ({ ok: true, value: data }),
} as MasterKeyProvider;

function makeCache(): ScopedKeyCache {
  const map = new Map<string, ScopedKeys>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); },
    has: (k) => map.has(k),
    delete: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

// A non-tenant scope column — the service is generic over the column name.
const table = { workspaceId: {} };
const scope = { column: 'workspaceId', value: 'w1' };

describe('createScopedKeyService — concurrent generation race', () => {
  it('retries the fetch when insert loses a unique race (SQLSTATE 23505 via cause chain)', async () => {
    const storedRow = {
      recipient: 'age1recipient',
      identityEncrypted: Buffer.from('AGE-SECRET-KEY-1X'),
      blindIndexKeyEncrypted: Buffer.from('deadbeef'),
      keyVersion: 1,
    };

    // First lookup: no row (triggers lazy generation). Insert then fails with
    // a wrapped unique violation (the concurrent request won). Second lookup
    // sees the winner's row.
    const findFirst = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(storedRow);
    const uniqueViolation = new Error('duplicate key value violates constraint', {
      cause: Object.assign(new Error('driver error'), { code: '23505' }),
    });
    const db: ScopedKeyDb = {
      insert: () => ({ values: async () => { throw uniqueViolation; } }),
      delete: () => ({ where: async () => {} }),
      query: { workspaceEncryptionKey: { findFirst } },
    };

    const service = createScopedKeyService({
      db, scope, masterKeyProvider, table, tableName: 'workspaceEncryptionKey', cache: makeCache(),
    });

    const result = await service.getKeys();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipient).toBe('age1recipient');
      expect(result.value.identity).toBe('AGE-SECRET-KEY-1X');
    }
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('surfaces non-conflict generation failures without retrying', async () => {
    const findFirst = vi.fn().mockResolvedValue(undefined);
    const db: ScopedKeyDb = {
      insert: () => ({ values: async () => { throw new Error('connection refused'); } }),
      delete: () => ({ where: async () => {} }),
      query: { workspaceEncryptionKey: { findFirst } },
    };

    const service = createScopedKeyService({
      db, scope, masterKeyProvider, table, tableName: 'workspaceEncryptionKey', cache: makeCache(),
    });

    const result = await service.getKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('scoped_key_generation_error');
      expect('conflict' in result.error && result.error.conflict).toBe(false);
    }
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('stamps the scope column on insert and keys the cache by scope value', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db: ScopedKeyDb = {
      insert: () => ({ values: async (v) => { inserted.push(v); } }),
      delete: () => ({ where: async () => {} }),
      query: { workspaceEncryptionKey: { findFirst: vi.fn().mockResolvedValue(undefined) } },
    };
    const cache = makeCache();

    const service = createScopedKeyService({
      db, scope, masterKeyProvider, table, tableName: 'workspaceEncryptionKey', cache,
    });

    const result = await service.generateKeyPair();
    expect(result.ok).toBe(true);
    expect(inserted[0]).toMatchObject({ workspaceId: 'w1' });
    expect(cache.has('w1')).toBe(true);
  });

  it('serves generated keys via getKeys/hasKeys for a consumer-chosen tenantId scope column', async () => {
    // A multi-tenant consumer binds the scope to its own `tenantId` column —
    // no dedicated preset needed; the generic service takes the column name.
    const inserted: Record<string, unknown>[] = [];
    const db: ScopedKeyDb = {
      insert: () => ({ values: async (v) => { inserted.push(v); } }),
      delete: () => ({ where: async () => {} }),
      query: { tenantEncryptionKey: { findFirst: vi.fn().mockResolvedValue(undefined) } },
    };
    const cache = makeCache();

    const service = createScopedKeyService({
      db,
      scope: { column: 'tenantId', value: 't1' },
      masterKeyProvider,
      table: { tenantId: {} },
      tableName: 'tenantEncryptionKey',
      cache,
    });

    const result = await service.generateKeyPair();
    expect(result.ok).toBe(true);
    expect(inserted[0]).toMatchObject({ tenantId: 't1' });
    expect(cache.has('t1')).toBe(true);

    const keys = await service.getKeys();
    expect(keys.ok).toBe(true);
    expect(await service.hasKeys()).toBe(true);
  });
});
