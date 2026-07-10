import { describe, it, expect, vi } from 'vitest';
import { pgTable, text, jsonb, boolean, timestamp } from 'drizzle-orm/pg-core';
import { ok, err, type Result, type OctError } from '../../result/index.ts';
import {
  createScopedConfigService,
  createScopedConfigCache,
  ScopedConfigDecryptError,
  type ConfigSchema,
  type ConfigDatabase,
  type ConfigCipher,
  type ConfigLruCache,
  type InvalidConfigValueError,
} from './index.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A concrete config table built from the shipped `scopedConfigColumns` shape
 * (incl. the audit columns), with a consumer-declared scope column added.
 */
const tenantConfig = pgTable('tenant_config', {
  tenantId: text('tenant_id').notNull(),
  key: text().notNull(),
  value: jsonb().notNull(),
  encrypted: boolean().notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
});

/**
 * An unscoped (single-tenant) config table — `key` is the sole primary key.
 * Deliberately has no audit columns, covering the guarded upsert-set path.
 */
const singleConfig = pgTable('single_config', {
  key: text().notNull(),
  value: jsonb().notNull(),
  encrypted: boolean().notNull().default(false),
});

/** The caller-owned config map + a tiny hand-rolled schema (no Zod dep here). */
type ConfigMap = {
  tenant_name: string;
  page_size: number;
  api_key: string;
};

const DEFAULTS: ConfigMap = { tenant_name: 'Default Co', page_size: 20, api_key: '' };

/**
 * Structural stand-in for a Zod discriminated-union schema: applies defaults
 * for missing values, type-checks the value, and reports failures.
 */
const schema: ConfigSchema<ConfigMap> = {
  safeParse({ key, value }) {
    const k = key as keyof ConfigMap;
    if (!(k in DEFAULTS)) return { success: false, error: { message: `unknown key ${key}` } };
    const applied = value === undefined || value === null ? DEFAULTS[k] : value;
    const expected = typeof DEFAULTS[k];
    if (typeof applied !== expected) {
      return { success: false, error: { message: `expected ${expected}, got ${typeof applied}` } };
    }
    return { success: true, data: { value: applied as ConfigMap[keyof ConfigMap] } };
  },
};

/** A reversible base64 "cipher" — enough to exercise the envelope round-trip. */
const cipher: ConfigCipher = {
  encrypt: async (plaintext) => ok(Buffer.from(plaintext, 'utf8').toString('base64')),
  decrypt: async (b64) => ok(Buffer.from(b64, 'base64').toString('utf8')),
};

/**
 * Mock db capturing inserted values / conflict spec and returning seeded rows
 * from the select builder. `rows` seeds what a read returns.
 */
function makeDb(rows: Array<{ key: string; value: unknown; encrypted: boolean }> = []) {
  const insertValues = vi.fn(async () => {});
  let capturedValues: unknown;
  let capturedConflict: unknown;
  const db: ConfigDatabase = {
    select: () => ({
      from: () => ({
        // readConfig passes a where; readAll passes a where too — both resolve to rows.
        where: async () => rows,
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        capturedValues = v;
        return {
          onConflictDoUpdate: (spec: unknown) => {
            capturedConflict = spec;
            return insertValues();
          },
        };
      },
    }),
  };
  return {
    db,
    insertValues,
    getValues: () => capturedValues as Array<Record<string, unknown>>,
    getConflict: () => capturedConflict as { target: unknown[]; set: Record<string, unknown> },
  };
}

function makeService(
  rows: Array<{ key: string; value: unknown; encrypted: boolean }> = [],
  overrides: Partial<Parameters<typeof createScopedConfigService<ConfigMap, 'tenantId'>>[0]> = {},
) {
  const { db, insertValues, getValues, getConflict } = makeDb(rows);
  const service = createScopedConfigService<ConfigMap, 'tenantId'>({
    db,
    table: tenantConfig,
    scope: { column: 'tenantId', value: 't1' },
    schema,
    encryptedKeys: ['api_key'],
    cacheableKeys: ['tenant_name', 'page_size'],
    keys: ['tenant_name', 'page_size', 'api_key'],
    cipher,
    ...overrides,
  });
  return { service, db, insertValues, getValues, getConflict };
}

// ---------------------------------------------------------------------------
// writeConfig — validation
// ---------------------------------------------------------------------------

describe('writeConfig validation', () => {
  it('rejects a value failing the schema and writes nothing', async () => {
    const { service, insertValues } = makeService();
    // page_size expects a number
    const r = await service.writeConfig({ page_size: 'not-a-number' as unknown as number });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.key).toBe('scoped_config_invalid_value');
    expect(!r.ok && (r.error as InvalidConfigValueError).configKey).toBe('page_size');
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('no-ops on an empty config', async () => {
    const { service, insertValues } = makeService();
    const r = await service.writeConfig({});
    expect(r.ok).toBe(true);
    expect(insertValues).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// writeConfig — upsert write path + encryption envelope
// ---------------------------------------------------------------------------

describe('writeConfig upsert + encryption envelope', () => {
  it('stamps the scope column and targets (key, scope) on conflict', async () => {
    const { service, getValues, getConflict } = makeService();
    const r = await service.writeConfig({ tenant_name: 'Acme' });
    expect(r.ok).toBe(true);
    const values = getValues();
    expect(values[0]).toMatchObject({ tenantId: 't1', key: 'tenant_name', value: 'Acme', encrypted: false });
    // Conflict updates value + encrypted from the excluded row and keeps the
    // audit columns current (updated_at would otherwise never change on upsert).
    expect(Object.keys(getConflict().set)).toEqual(['value', 'encrypted', 'updatedAt', 'updatedBy']);
    expect(getConflict().target).toHaveLength(2);
  });

  it('omits the audit columns from the conflict set when the table lacks them', async () => {
    const { db, getConflict } = makeDb();
    const service = createScopedConfigService<ConfigMap>({
      db, table: singleConfig, schema, keys: ['tenant_name', 'page_size', 'api_key'],
    });
    await service.writeConfig({ tenant_name: 'Acme' });
    expect(Object.keys(getConflict().set)).toEqual(['value', 'encrypted']);
  });

  it('wraps an encrypted key in a { __encrypted } base64 envelope', async () => {
    const { service, getValues } = makeService();
    await service.writeConfig({ api_key: 'secret-123' });
    const row = getValues()[0]!;
    expect(row.encrypted).toBe(true);
    const wrapper = row.value as { __encrypted: string };
    expect(wrapper.__encrypted).toBe(Buffer.from(JSON.stringify('secret-123'), 'utf8').toString('base64'));
  });

  it('round-trips an encrypted value: writeConfig envelope decrypts on readConfig', async () => {
    // Encrypt exactly as writeConfig would, then feed the row back to readConfig.
    const enc = Buffer.from(JSON.stringify('secret-123'), 'utf8').toString('base64');
    const { service } = makeService([{ key: 'api_key', value: { __encrypted: enc }, encrypted: true }]);
    const out = await service.readConfig('api_key');
    expect(out.api_key).toBe('secret-123');
  });

  it('propagates a cipher error from writeConfig', async () => {
    const failingCipher: ConfigCipher = {
      encrypt: async (): Promise<Result<string, OctError>> => err({ key: 'boom', message: 'nope' }),
      decrypt: async () => ok(''),
    };
    const { service, insertValues } = makeService([], { cipher: failingCipher });
    const r = await service.writeConfig({ api_key: 'x' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.key).toBe('boom');
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('warns and stores plaintext when an encrypted key has no cipher', async () => {
    const warn = vi.fn();
    const { service, getValues } = makeService([], { cipher: undefined, logger: { warn, error: vi.fn() } });
    await service.writeConfig({ api_key: 'plain' });
    expect(warn).toHaveBeenCalled();
    expect(getValues()[0]).toMatchObject({ key: 'api_key', value: 'plain', encrypted: false });
  });
});

// ---------------------------------------------------------------------------
// readConfig — defaults + decrypt failure
// ---------------------------------------------------------------------------

describe('readConfig defaults', () => {
  it('applies schema defaults for absent rows', async () => {
    const { service } = makeService([]); // nothing stored
    const out = await service.readConfig('tenant_name', 'page_size');
    expect(out).toEqual({ tenant_name: 'Default Co', page_size: 20 });
  });

  it('returns stored values re-validated through the schema', async () => {
    const { service } = makeService([{ key: 'tenant_name', value: 'Acme', encrypted: false }]);
    const out = await service.readConfig('tenant_name');
    expect(out.tenant_name).toBe('Acme');
  });

  it('returns {} for no keys requested', async () => {
    const { service } = makeService();
    expect(await service.readConfig()).toEqual({});
  });

  it('throws ScopedConfigDecryptError when an encrypted row cannot be decrypted', async () => {
    const failing: ConfigCipher = {
      encrypt: async () => ok(''),
      decrypt: async (): Promise<Result<string, OctError>> => err({ key: 'x', message: 'bad' }),
    };
    const { service } = makeService(
      [{ key: 'api_key', value: { __encrypted: 'zzz' }, encrypted: true }],
      { cipher: failing },
    );
    await expect(service.readConfig('api_key')).rejects.toBeInstanceOf(ScopedConfigDecryptError);
  });

  it('throws when an encrypted row is missing its wrapper', async () => {
    const { service } = makeService([{ key: 'api_key', value: 'raw-not-wrapped', encrypted: true }]);
    await expect(service.readConfig('api_key')).rejects.toMatchObject({ reason: 'decrypt_failed' });
  });
});

// ---------------------------------------------------------------------------
// readConfig — invalid stored rows fall back to defaults (not silently dropped)
// ---------------------------------------------------------------------------

describe('readConfig invalid stored rows', () => {
  it('falls back to the schema default and warns when a stored row fails validation', async () => {
    const warn = vi.fn();
    // page_size expects a number; a legacy row stored a string (older schema).
    const { service } = makeService(
      [{ key: 'page_size', value: 'legacy-string', encrypted: false }],
      { logger: { warn, error: vi.fn() } },
    );
    const out = await service.readConfig('page_size');
    // The documented default is returned instead of the key being dropped.
    expect(out.page_size).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    const [, attrs] = warn.mock.calls[0]!;
    expect(attrs).toMatchObject({ key: 'page_size', scope: 't1' });
    // The raw (possibly sensitive) value must never be logged.
    expect(JSON.stringify(attrs)).not.toContain('legacy-string');
  });

  it('leaves the key absent when an invalid stored row has no schema default', async () => {
    const warn = vi.fn();
    // A schema where page_size has NO default: an absent/invalid value fails.
    const noDefaultSchema: ConfigSchema<ConfigMap> = {
      safeParse({ key, value }) {
        if (key !== 'page_size') return schema.safeParse({ key, value });
        if (typeof value !== 'number') {
          return { success: false, error: { message: 'page_size must be a number' } };
        }
        return { success: true, data: { value } };
      },
    };
    const { service } = makeService(
      [{ key: 'page_size', value: 'legacy-string', encrypted: false }],
      { schema: noDefaultSchema, logger: { warn, error: vi.fn() } },
    );
    const out = await service.readConfig('page_size');
    // No default to fall back to → key stays absent from the result.
    expect('page_size' in out).toBe(false);
    // The dropped stored row is still surfaced as a warning.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('caches the fallback default exactly like an absent row (both tiers)', async () => {
    const store = new Map<string, unknown>();
    const lru: ConfigLruCache = {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
      delete: (k) => store.delete(k),
    };
    const cache = createScopedConfigCache<ConfigMap>({ cache: lru, cacheableKeys: ['page_size'] });
    const { service } = makeService(
      [{ key: 'page_size', value: 'legacy-string', encrypted: false }],
      { cache, cacheableKeys: ['page_size'], logger: { warn: vi.fn(), error: vi.fn() } },
    );
    const out = await service.readConfig('page_size');
    expect(out.page_size).toBe(20);
    // The default is promoted into the cross-scope cache, same as an absent read —
    // not the (invalid) stored value.
    expect(store.get('t1:page_size')).toBe(20);
    // The request-scoped tier serves the default on a repeat read (no db needed).
    expect((await service.readConfig('page_size')).page_size).toBe(20);
  });

  it('leaves valid stored rows unaffected and logs no warning', async () => {
    const warn = vi.fn();
    const { service } = makeService(
      [{ key: 'page_size', value: 50, encrypted: false }],
      { logger: { warn, error: vi.fn() } },
    );
    const out = await service.readConfig('page_size');
    expect(out.page_size).toBe(50);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readConfig — onInvalidStoredValue: 'skip' (surface corrupt/legacy values)
// ---------------------------------------------------------------------------

describe("readConfig onInvalidStoredValue: 'skip'", () => {
  it('leaves the key absent (not the schema default) when a stored row fails validation', async () => {
    const warn = vi.fn();
    // page_size HAS a default (20); 'skip' must NOT fall back to it — the
    // corrupt/legacy row surfaces as a missing key instead.
    const { service } = makeService(
      [{ key: 'page_size', value: 'legacy-string', encrypted: false }],
      { onInvalidStoredValue: 'skip', logger: { warn, error: vi.fn() } },
    );
    const out = await service.readConfig('page_size');
    expect('page_size' in out).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [, attrs] = warn.mock.calls[0]!;
    expect(attrs).toMatchObject({ key: 'page_size', scope: 't1' });
    // The raw (possibly sensitive) value must never be logged.
    expect(JSON.stringify(attrs)).not.toContain('legacy-string');
  });

  it('does not cache or write anything for a skipped invalid row (both tiers)', async () => {
    const store = new Map<string, unknown>();
    const lru: ConfigLruCache = {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
      delete: (k) => store.delete(k),
    };
    const cache = createScopedConfigCache<ConfigMap>({ cache: lru, cacheableKeys: ['page_size'] });
    const { service } = makeService(
      [{ key: 'page_size', value: 'legacy-string', encrypted: false }],
      {
        onInvalidStoredValue: 'skip',
        cache,
        cacheableKeys: ['page_size'],
        logger: { warn: vi.fn(), error: vi.fn() },
      },
    );
    expect('page_size' in (await service.readConfig('page_size'))).toBe(false);
    // Nothing promoted into the cross-scope cache — a skipped row is not a value.
    expect(store.has('t1:page_size')).toBe(false);
    // A repeat read still skips (no stale default cached in the request tier).
    expect('page_size' in (await service.readConfig('page_size'))).toBe(false);
  });

  it("still applies the default for a genuinely absent row under 'skip'", async () => {
    // 'skip' only affects PRESENT-but-invalid rows; a missing row still defaults.
    const { service } = makeService([], {
      onInvalidStoredValue: 'skip',
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const out = await service.readConfig('page_size');
    expect(out.page_size).toBe(20);
  });

  it("defaults to 'use-default' when the policy is unset", async () => {
    const { service } = makeService([
      { key: 'page_size', value: 'legacy-string', encrypted: false },
    ]);
    const out = await service.readConfig('page_size');
    expect(out.page_size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// readAll
// ---------------------------------------------------------------------------

describe('readAll', () => {
  it('reads every declared key, applying defaults for absent ones', async () => {
    const { service } = makeService([{ key: 'tenant_name', value: 'Acme', encrypted: false }]);
    const out = await service.readAll();
    expect(out).toEqual({ tenant_name: 'Acme', page_size: 20, api_key: '' });
  });

  it('returns a copy — caller mutations cannot poison the internal cache', async () => {
    const { service } = makeService([{ key: 'tenant_name', value: 'Acme', encrypted: false }]);
    const first = await service.readAll();
    first.tenant_name = 'MUTATED';
    delete first.page_size;

    const second = await service.readAll(); // served from the internal cache
    expect(second).toEqual({ tenant_name: 'Acme', page_size: 20, api_key: '' });

    // The cache-hit path must also hand out a fresh object each time.
    second.tenant_name = 'MUTATED-AGAIN';
    expect((await service.readAll()).tenant_name).toBe('Acme');
  });
});

// ---------------------------------------------------------------------------
// Caching — hit/miss + cacheable gating
// ---------------------------------------------------------------------------

describe('cross-scope cache', () => {
  function makeLru() {
    const store = new Map<string, unknown>();
    const lru: ConfigLruCache = {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
      delete: (k) => store.delete(k),
    };
    return { store, lru };
  }

  it('serves a cache hit without hitting the db, and only caches cacheable keys', async () => {
    const { lru, store } = makeLru();
    const cache = createScopedConfigCache<ConfigMap>({ cache: lru, cacheableKeys: ['tenant_name', 'page_size'] });

    // First service populates the cache from a db read.
    const dbSpy = { rows: [{ key: 'tenant_name', value: 'Acme', encrypted: false }] };
    const from = vi.fn(() => ({ where: async () => dbSpy.rows }));
    const db1: ConfigDatabase = { select: () => ({ from }), insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }) };
    const s1 = createScopedConfigService<ConfigMap, 'tenantId'>({
      db: db1, table: tenantConfig, scope: { column: 'tenantId', value: 't1' }, schema,
      cacheableKeys: ['tenant_name', 'page_size'], cache,
    });
    await s1.readConfig('tenant_name');
    expect(store.has('t1:tenant_name')).toBe(true);

    // Second service (fresh request scope) reads the same key: cache hit, db.select never called.
    const select2 = vi.fn();
    const db2: ConfigDatabase = { select: select2, insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }) };
    const s2 = createScopedConfigService<ConfigMap, 'tenantId'>({
      db: db2, table: tenantConfig, scope: { column: 'tenantId', value: 't1' }, schema,
      cacheableKeys: ['tenant_name', 'page_size'], cache,
    });
    const out = await s2.readConfig('tenant_name');
    expect(out.tenant_name).toBe('Acme');
    expect(select2).not.toHaveBeenCalled();
  });

  it('does not store non-cacheable keys', async () => {
    const { lru, store } = makeLru();
    const cache = createScopedConfigCache<ConfigMap>({ cache: lru, cacheableKeys: ['tenant_name'] });
    cache.set('t1', 'api_key', 'secret'); // api_key is NOT cacheable
    expect(store.size).toBe(0);
    cache.set('t1', 'tenant_name', 'Acme');
    expect(store.get('t1:tenant_name')).toBe('Acme');
  });

  it('invalidate clears every cacheable key for the scope', async () => {
    const { lru, store } = makeLru();
    const cache = createScopedConfigCache<ConfigMap>({ cache: lru, cacheableKeys: ['tenant_name', 'page_size'] });
    cache.set('t1', 'tenant_name', 'Acme');
    cache.set('t1', 'page_size', 50);
    cache.invalidate('t1');
    expect(store.size).toBe(0);
  });

  it("cache keys cannot collide across the scope/key boundary ('a'+'b:c' vs 'a:b'+'c')", () => {
    type CollisionMap = { 'b:c': string; c: string };
    const { lru } = makeLru();
    const cache = createScopedConfigCache<CollisionMap>({ cache: lru, cacheableKeys: ['b:c', 'c'] });

    cache.set('a', 'b:c', 'first');
    cache.set('a:b', 'c', 'second');

    expect(cache.get('a', 'b:c')).toBe('first'); // not clobbered by the second write
    expect(cache.get('a:b', 'c')).toBe('second');

    // Invalidating one scope must not evict the other pair either.
    cache.invalidate('a:b');
    expect(cache.get('a', 'b:c')).toBe('first');
    expect(cache.get('a:b', 'c')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

describe('scope isolation', () => {
  it('writeConfig stamps the bound scope value on every row', async () => {
    const { service, getValues } = makeService();
    await service.writeConfig({ tenant_name: 'Acme', page_size: 30 });
    for (const row of getValues()) expect(row.tenantId).toBe('t1');
  });

  it('separate scopes do not share cached values', async () => {
    const store = new Map<string, unknown>();
    const lru: ConfigLruCache = { get: (k) => store.get(k), set: (k, v) => void store.set(k, v), delete: (k) => store.delete(k) };
    const cache = createScopedConfigCache<ConfigMap>({ cache: lru, cacheableKeys: ['tenant_name'] });
    cache.set('t1', 'tenant_name', 'Acme');
    expect(cache.get('t1', 'tenant_name')).toBe('Acme');
    expect(cache.get('t2', 'tenant_name')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unscoped store (scope omitted)
// ---------------------------------------------------------------------------

describe('unscoped config store (no scope)', () => {
  function makeUnscoped(
    rows: Array<{ key: string; value: unknown; encrypted: boolean }> = [],
  ) {
    const { db, insertValues, getValues, getConflict } = makeDb(rows);
    const service = createScopedConfigService<ConfigMap>({
      db,
      table: singleConfig,
      // scope omitted → unscoped
      schema,
      encryptedKeys: ['api_key'],
      keys: ['tenant_name', 'page_size', 'api_key'],
      cipher,
    });
    return { service, insertValues, getValues, getConflict };
  }

  it('writes rows without a scope column and targets (key) alone on conflict', async () => {
    const { service, getValues, getConflict } = makeUnscoped();
    const r = await service.writeConfig({ tenant_name: 'Acme' });
    expect(r.ok).toBe(true);
    const row = getValues()[0]!;
    expect(row).toMatchObject({ key: 'tenant_name', value: 'Acme', encrypted: false });
    expect(row).not.toHaveProperty('tenantId');
    // Unscoped conflict target is the single key column.
    expect(getConflict().target).toHaveLength(1);
  });

  it('reads a stored value back (no scope filter)', async () => {
    const { service } = makeUnscoped([{ key: 'tenant_name', value: 'Acme', encrypted: false }]);
    const out = await service.readConfig('tenant_name');
    expect(out.tenant_name).toBe('Acme');
  });

  it('applies schema defaults for absent rows', async () => {
    const { service } = makeUnscoped([]);
    const out = await service.readConfig('tenant_name', 'page_size');
    expect(out).toEqual({ tenant_name: 'Default Co', page_size: 20 });
  });

  it('readAll returns every declared key with defaults applied', async () => {
    const { service } = makeUnscoped([{ key: 'page_size', value: 50, encrypted: false }]);
    const out = await service.readAll();
    expect(out).toEqual({ tenant_name: 'Default Co', page_size: 50, api_key: '' });
  });

  it('round-trips an encrypted value with no scope', async () => {
    const enc = Buffer.from(JSON.stringify('secret-123'), 'utf8').toString('base64');
    const { service } = makeUnscoped([{ key: 'api_key', value: { __encrypted: enc }, encrypted: true }]);
    const out = await service.readConfig('api_key');
    expect(out.api_key).toBe('secret-123');
  });

  it('serves an unscoped request-scoped cache hit on repeat reads', async () => {
    const { service } = makeUnscoped([{ key: 'tenant_name', value: 'Acme', encrypted: false }]);
    expect((await service.readConfig('tenant_name')).tenant_name).toBe('Acme');
    // Second read is served from the request-scoped cache (same instance).
    expect((await service.readConfig('tenant_name')).tenant_name).toBe('Acme');
  });

  it('shares a cross-scope cache under a single ("") partition', async () => {
    const store = new Map<string, unknown>();
    const lru: ConfigLruCache = { get: (k) => store.get(k), set: (k, v) => void store.set(k, v), delete: (k) => store.delete(k) };
    const cache = createScopedConfigCache<ConfigMap>({ cache: lru, cacheableKeys: ['tenant_name'] });
    const { db } = makeDb([{ key: 'tenant_name', value: 'Acme', encrypted: false }]);
    const service = createScopedConfigService<ConfigMap>({
      db, table: singleConfig, schema, cacheableKeys: ['tenant_name'], cache,
    });
    await service.readConfig('tenant_name');
    expect(store.has(':tenant_name')).toBe(true); // '' scope partition
  });
});
