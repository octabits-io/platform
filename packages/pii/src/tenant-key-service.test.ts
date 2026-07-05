import { describe, it, expect, vi } from 'vitest';
import { createTenantKeyService } from './tenant-key-service.ts';
import type { ScopedKeyCache, ScopedKeyDb, ScopedKeys } from './scoped-key-service.ts';
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

const table = { tenantId: {} };

describe('createTenantKeyService — tenant preset', () => {
  it('accepts the tenantId deps signature and stamps the tenantId column on insert', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db: ScopedKeyDb = {
      insert: () => ({ values: async (v) => { inserted.push(v); } }),
      delete: () => ({ where: async () => {} }),
      query: { tenantEncryptionKey: { findFirst: vi.fn().mockResolvedValue(undefined) } },
    };
    const cache = makeCache();

    const service = createTenantKeyService({
      db, tenantId: 't1', masterKeyProvider, table, tableName: 'tenantEncryptionKey', cache,
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
