import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@octabits-io/foundation/result';
import {
  createScopedKeyService,
  type ScopedKeyCache,
  type ScopedKeyStore,
  type ScopedKeyRow,
  type ScopedKeys,
} from './scoped-key-service.ts';
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
const scope = { column: 'workspaceId', value: 'w1' };

/**
 * An in-memory store: `insert` records the row (stamping a keyVersion),
 * `find`/`exists` serve it back. `keyVersion` is configurable so read-back
 * behavior can be asserted.
 */
function makeInMemoryStore(keyVersion = 1) {
  let row: ScopedKeyRow | null = null;
  const insert = vi.fn(async (r) => { row = { ...r, keyVersion }; return ok(undefined); });
  const find = vi.fn(async () => ok(row));
  const exists = vi.fn(async () => ok(row !== null));
  const destroy = vi.fn(async () => { row = null; return ok(undefined); });
  const store: ScopedKeyStore = { insert, find, exists, destroy };
  return { store, insert, find, exists, destroy, getRow: () => row };
}

describe('createScopedKeyService — concurrent generation race', () => {
  it('retries the fetch when insert loses a unique race (store conflict)', async () => {
    const storedRow: ScopedKeyRow = {
      recipient: 'age1recipient',
      identityEncrypted: Buffer.from('AGE-SECRET-KEY-1X'),
      blindIndexKeyEncrypted: Buffer.from('deadbeef'),
      keyVersion: 1,
    };

    // First lookup: no row (triggers lazy generation). Insert then loses the
    // unique race → store conflict. Second lookup sees the winner's row.
    const find = vi.fn()
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(storedRow));
    const insert = vi.fn(async () => err({ key: 'scoped_key_store_conflict' as const, message: 'exists' }));
    const store: ScopedKeyStore = {
      insert, find,
      exists: async () => ok(false),
      destroy: async () => ok(undefined),
    };

    const service = createScopedKeyService({ store, scope, masterKeyProvider, cache: makeCache() });

    const result = await service.getKeys();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipient).toBe('age1recipient');
      expect(result.value.identity).toBe('AGE-SECRET-KEY-1X');
    }
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('surfaces non-conflict generation failures without retrying', async () => {
    const find = vi.fn(async () => ok(null));
    const insert = vi.fn(async () => err({ key: 'scoped_key_store_failure' as const, message: 'connection refused' }));
    const store: ScopedKeyStore = {
      insert, find,
      exists: async () => ok(false),
      destroy: async () => ok(undefined),
    };

    const service = createScopedKeyService({ store, scope, masterKeyProvider, cache: makeCache() });

    const result = await service.getKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('scoped_key_generation_error');
      expect('conflict' in result.error && result.error.conflict).toBe(false);
    }
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('bounds the conflict-retry recursion: errs instead of recursing when the row never appears', async () => {
    // Pathological store: insert always loses the unique race, yet the fetch
    // never sees the winning row. Unbounded recursion would loop forever.
    const find = vi.fn(async () => ok(null));
    const insert = vi.fn(async () => err({ key: 'scoped_key_store_conflict' as const, message: 'exists' }));
    const store: ScopedKeyStore = {
      insert, find,
      exists: async () => ok(false),
      destroy: async () => ok(undefined),
    };

    const service = createScopedKeyService({ store, scope, masterKeyProvider, cache: makeCache() });

    const result = await service.getKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_generation_error');
    // Depth is bounded to 1 retry: two fetches, one insert — no runaway loop.
    expect(find).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe('createScopedKeyService — generation & cache semantics', () => {
  it('hands the store exactly the 3-field row (no scope column) and caches with the persisted keyVersion', async () => {
    // The persisted row carries a DB-assigned keyVersion (e.g. after rotation).
    const { store, insert } = makeInMemoryStore(7);
    const cache = makeCache();

    const service = createScopedKeyService({ store, scope, masterKeyProvider, cache });

    const result = await service.generateKeyPair();
    expect(result.ok).toBe(true);

    // Stamping the scope column is the store's job — the service passes only
    // the three key fields, never the scope key.
    expect(insert).toHaveBeenCalledTimes(1);
    const insertedRow = insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(insertedRow).sort()).toEqual(
      ['blindIndexKeyEncrypted', 'identityEncrypted', 'recipient'],
    );
    expect(insertedRow).not.toHaveProperty('workspaceId');

    // Cache key is `${column}:${value}` (URI-encoded), not the bare scope value.
    expect(cache.keys()).toEqual(['workspaceId:w1']);
    // keyVersion is read back from the persisted row, not hardcoded to 1.
    expect(cache.get('workspaceId:w1')?.keyVersion).toBe(7);
  });

  it('does NOT pre-populate the cache when generating through a caller-provided transaction store', async () => {
    // If the caller's transaction rolls back after generateKeyPair(txStore), a
    // cached key would reference a row that never existed — every value
    // encrypted with it would be unrecoverable.
    const main = makeInMemoryStore();
    const tx = makeInMemoryStore();
    const cache = makeCache();

    const service = createScopedKeyService({ store: main.store, scope, masterKeyProvider, cache });

    const result = await service.generateKeyPair(tx.store);
    expect(result.ok).toBe(true);
    // The write landed on the tx store; the main store is untouched (no insert,
    // no read-back find).
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(main.insert).not.toHaveBeenCalled();
    expect(main.find).not.toHaveBeenCalled();
    expect(cache.keys()).toEqual([]);
  });

  it('qualifies cache keys by scope column so services sharing a cache do not collide', async () => {
    const cache = makeCache();
    const a = makeInMemoryStore();
    const b = makeInMemoryStore();

    const workspaceService = createScopedKeyService({
      store: a.store, scope: { column: 'workspaceId', value: 'x' }, masterKeyProvider, cache,
    });
    const tenantService = createScopedKeyService({
      store: b.store, scope: { column: 'tenantId', value: 'x' }, masterKeyProvider, cache,
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
    const { store } = makeInMemoryStore();
    const cache = makeCache();

    const service = createScopedKeyService({
      store, scope: { column: 'tenantId', value: 't1' }, masterKeyProvider, cache,
    });

    const result = await service.generateKeyPair();
    expect(result.ok).toBe(true);
    expect(cache.has('tenantId:t1')).toBe(true);

    const keys = await service.getKeys();
    expect(keys.ok).toBe(true);
    const has = await service.hasKeys();
    expect(has.ok).toBe(true);
    if (has.ok) expect(has.value).toBe(true);
  });
});

describe('createScopedKeyService — storage failures return err instead of throwing', () => {
  function failingStore(): ScopedKeyStore {
    return {
      insert: async () => err({ key: 'scoped_key_store_failure', message: 'boom-insert' }),
      find: async () => err({ key: 'scoped_key_store_failure', message: 'boom-find' }),
      exists: async () => err({ key: 'scoped_key_store_failure', message: 'boom-exists' }),
      destroy: async () => err({ key: 'scoped_key_store_failure', message: 'boom-destroy' }),
    };
  }

  it('getKeys wraps a store find failure into scoped_key_storage_error', async () => {
    const service = createScopedKeyService({ store: failingStore(), scope, masterKeyProvider, cache: makeCache() });
    const result = await service.getKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('scoped_key_storage_error');
      expect(result.error.message).toContain('boom-find');
    }
  });

  it('hasKeys wraps a store exists failure into scoped_key_storage_error', async () => {
    const service = createScopedKeyService({ store: failingStore(), scope, masterKeyProvider, cache: makeCache() });
    const result = await service.hasKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_storage_error');
  });

  it('destroyKeys wraps a store destroy failure into scoped_key_storage_error and drops the cache first', async () => {
    const cache = makeCache();
    // Seed a cached entry so we can prove it is dropped even when destroy fails.
    cache.set('workspaceId:w1', { recipient: 'r', identity: 'i', blindIndexKey: 'b', keyVersion: 1 });

    const service = createScopedKeyService({ store: failingStore(), scope, masterKeyProvider, cache });
    const result = await service.destroyKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_storage_error');
    // Cache is invalidated before the store call, regardless of its outcome.
    expect(cache.has('workspaceId:w1')).toBe(false);
  });
});
