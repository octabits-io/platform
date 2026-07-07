import { describe, it, expect, vi } from 'vitest';
import { createScopedKeyService, type ScopedKeyCache, type ScopedKeyDb, type ScopedKeys } from './scoped-key-service.ts';
import type { MasterKeyProvider } from './master-key.ts';

const masterKeyProvider: MasterKeyProvider = {
  encrypt: async (data: Buffer) => ({ ok: true, value: data }),
  decrypt: async (data: Buffer) => ({ ok: true, value: data }),
} as MasterKeyProvider;

function makeCache(): ScopedKeyCache & { keys(): string[] } {
  const map = new Map<string, ScopedKeys>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); },
    has: (k) => map.has(k),
    delete: (k) => map.delete(k),
    clear: () => map.clear(),
    keys: () => [...map.keys()],
  };
}

// A non-tenant scope column — the service is generic over the column name.
const table = { workspaceId: {} };
const scope = { column: 'workspaceId', value: 'w1' };

/** A db whose insert records rows and whose findFirst serves them back. */
function makeInMemoryDb(tableName: string) {
  const inserted: Record<string, unknown>[] = [];
  const findFirst = vi.fn().mockImplementation(async () => {
    const v = inserted[0];
    if (!v) return undefined;
    return {
      recipient: v['recipient'],
      identityEncrypted: v['identityEncrypted'],
      blindIndexKeyEncrypted: v['blindIndexKeyEncrypted'],
      keyVersion: 1,
    };
  });
  const db: ScopedKeyDb = {
    insert: () => ({ values: async (v) => { inserted.push(v); } }),
    delete: () => ({ where: async () => {} }),
    query: { [tableName]: { findFirst } },
  };
  return { db, inserted, findFirst };
}

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

  it('bounds the conflict-retry recursion: errs instead of recursing when the row never appears', async () => {
    // Pathological store: insert always loses the unique race, yet the fetch
    // never sees the winning row. Unbounded recursion would loop forever.
    const findFirst = vi.fn().mockResolvedValue(undefined);
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    const insert = vi.fn(() => ({ values: async () => { throw uniqueViolation; } }));
    const db: ScopedKeyDb = {
      insert,
      delete: () => ({ where: async () => {} }),
      query: { workspaceEncryptionKey: { findFirst } },
    };

    const service = createScopedKeyService({
      db, scope, masterKeyProvider, table, tableName: 'workspaceEncryptionKey', cache: makeCache(),
    });

    const result = await service.getKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_generation_error');
    // Depth is bounded to 1 retry: two fetches, one insert — no runaway loop.
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe('createScopedKeyService — generation & cache semantics', () => {
  it('stamps the scope column on insert and caches under a column-qualified key with the persisted keyVersion', async () => {
    const { db, inserted, findFirst } = makeInMemoryDb('workspaceEncryptionKey');
    // The persisted row carries a DB-assigned keyVersion (e.g. after rotation).
    findFirst.mockImplementation(async () => {
      const v = inserted[0];
      return v && {
        recipient: v['recipient'],
        identityEncrypted: v['identityEncrypted'],
        blindIndexKeyEncrypted: v['blindIndexKeyEncrypted'],
        keyVersion: 7,
      };
    });
    const cache = makeCache();

    const service = createScopedKeyService({
      db, scope, masterKeyProvider, table, tableName: 'workspaceEncryptionKey', cache,
    });

    const result = await service.generateKeyPair();
    expect(result.ok).toBe(true);
    expect(inserted[0]).toMatchObject({ workspaceId: 'w1' });
    // Cache key is `${column}:${value}` (URI-encoded), not the bare scope value.
    expect(cache.keys()).toEqual(['workspaceId:w1']);
    // keyVersion is read back from the persisted row, not hardcoded to 1.
    expect(cache.get('workspaceId:w1')?.keyVersion).toBe(7);
  });

  it('does NOT pre-populate the cache when generating inside a caller-provided transaction', async () => {
    // If the caller's transaction rolls back after generateKeyPair(tx), a
    // cached key would reference a row that never existed — every value
    // encrypted with it would be unrecoverable.
    const txInserted: Record<string, unknown>[] = [];
    const tx: ScopedKeyDb = {
      insert: () => ({ values: async (v) => { txInserted.push(v); } }),
      delete: () => ({ where: async () => {} }),
      query: {},
    };
    const { db } = makeInMemoryDb('workspaceEncryptionKey');
    const cache = makeCache();

    const service = createScopedKeyService({
      db, scope, masterKeyProvider, table, tableName: 'workspaceEncryptionKey', cache,
    });

    const result = await service.generateKeyPair(tx);
    expect(result.ok).toBe(true);
    expect(txInserted).toHaveLength(1);
    expect(cache.keys()).toEqual([]);
  });

  it('qualifies cache keys by scope column so services sharing a cache do not collide', async () => {
    const cache = makeCache();
    const a = makeInMemoryDb('workspaceEncryptionKey');
    const b = makeInMemoryDb('tenantEncryptionKey');

    const workspaceService = createScopedKeyService({
      db: a.db, scope: { column: 'workspaceId', value: 'x' }, masterKeyProvider,
      table: { workspaceId: {} }, tableName: 'workspaceEncryptionKey', cache,
    });
    const tenantService = createScopedKeyService({
      db: b.db, scope: { column: 'tenantId', value: 'x' }, masterKeyProvider,
      table: { tenantId: {} }, tableName: 'tenantEncryptionKey', cache,
    });

    const wsKeys = await workspaceService.getKeys();
    const tenantKeys = await tenantService.getKeys();
    expect(wsKeys.ok).toBe(true);
    expect(tenantKeys.ok).toBe(true);
    expect(cache.keys().sort()).toEqual(['tenantId:x', 'workspaceId:x']);
    if (wsKeys.ok && tenantKeys.ok) {
      expect(wsKeys.value.recipient).not.toBe(tenantKeys.value.recipient);
    }
  });

  it('serves generated keys via getKeys/hasKeys for a consumer-chosen tenantId scope column', async () => {
    // A multi-tenant consumer binds the scope to its own `tenantId` column —
    // no dedicated preset needed; the generic service takes the column name.
    const { db, inserted } = makeInMemoryDb('tenantEncryptionKey');
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
    expect(cache.has('tenantId:t1')).toBe(true);

    const keys = await service.getKeys();
    expect(keys.ok).toBe(true);
    const has = await service.hasKeys();
    expect(has.ok).toBe(true);
    if (has.ok) expect(has.value).toBe(true);
  });
});

describe('createScopedKeyService — storage failures return err instead of throwing', () => {
  function throwingDb(): ScopedKeyDb {
    return {
      insert: () => ({ values: async () => { throw new Error('boom-insert'); } }),
      delete: () => ({ where: async () => { throw new Error('boom-delete'); } }),
      query: { workspaceEncryptionKey: { findFirst: async () => { throw new Error('boom-select'); } } },
    };
  }

  it('getKeys wraps a throwing fetch into scoped_key_storage_error', async () => {
    const service = createScopedKeyService({
      db: throwingDb(), scope, masterKeyProvider, table, tableName: 'workspaceEncryptionKey', cache: makeCache(),
    });
    const result = await service.getKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('scoped_key_storage_error');
      expect(result.error.message).toContain('boom-select');
    }
  });

  it('hasKeys wraps a throwing fetch into scoped_key_storage_error', async () => {
    const service = createScopedKeyService({
      db: throwingDb(), scope, masterKeyProvider, table, tableName: 'workspaceEncryptionKey', cache: makeCache(),
    });
    const result = await service.hasKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_storage_error');
  });

  it('destroyKeys wraps a throwing delete into scoped_key_storage_error', async () => {
    const service = createScopedKeyService({
      db: throwingDb(), scope, masterKeyProvider, table, tableName: 'workspaceEncryptionKey', cache: makeCache(),
    });
    const result = await service.destroyKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_storage_error');
  });
});
