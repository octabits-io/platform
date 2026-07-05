import { describe, it, expect, vi } from 'vitest';
import { createTenantKeyService, type TenantKeyCache, type TenantKeyDb, type TenantKeys } from './tenant-key-service.ts';
import type { MasterKeyProvider } from './master-key.ts';

const masterKeyProvider: MasterKeyProvider = {
  encrypt: async (data: Buffer) => ({ ok: true, value: data }),
  decrypt: async (data: Buffer) => ({ ok: true, value: data }),
} as MasterKeyProvider;

function makeCache(): TenantKeyCache {
  const map = new Map<string, TenantKeys>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); },
    has: (k) => map.has(k),
    delete: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

const table = { tenantId: {} };

describe('createTenantKeyService — concurrent generation race', () => {
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
    const db: TenantKeyDb = {
      insert: () => ({ values: async () => { throw uniqueViolation; } }),
      delete: () => ({ where: async () => {} }),
      query: { tenantEncryptionKey: { findFirst } },
    };

    const service = createTenantKeyService({
      db, tenantId: 't1', masterKeyProvider, table, tableName: 'tenantEncryptionKey', cache: makeCache(),
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
    const db: TenantKeyDb = {
      insert: () => ({ values: async () => { throw new Error('connection refused'); } }),
      delete: () => ({ where: async () => {} }),
      query: { tenantEncryptionKey: { findFirst } },
    };

    const service = createTenantKeyService({
      db, tenantId: 't1', masterKeyProvider, table, tableName: 'tenantEncryptionKey', cache: makeCache(),
    });

    const result = await service.getKeys();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('tenant_key_generation_error');
      expect('conflict' in result.error && result.error.conflict).toBe(false);
    }
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
