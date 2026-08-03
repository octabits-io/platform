import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { IoC, ServiceLifetime } from '../../ioc/index.ts';
import { createDrizzle } from '../factory/index.ts';
import {
  createScopedDb,
  createGucScopeFactory,
  createPinnedGucScopeFactory,
  assertSafeGucListValue,
  joinGucList,
  runWithGucs,
  withSystemMode,
  acquireScopedClient,
  releaseScopedClient,
  escapeGucLiteral,
  QUERY_BUILDER_METHODS,
  type RlsDatabase,
} from './index.ts';

/** Fake db whose transaction records executed set_config GUCs. */
function makeDb() {
  const gucCalls: string[][] = [];
  const rows = [{ id: 'r1' }];
  const withArgs: unknown[] = [];
  const chain = { from: () => chain, where: () => Promise.resolve(rows) };
  const tx = {
    execute: vi.fn(async (q: { queryChunks?: unknown[] } | string) => { gucCalls.push([JSON.stringify(q)]); return []; }),
    select: () => chain,
    selectDistinct: () => chain,
    insert: () => ({ values: async () => rows }),
    with: (...ctes: unknown[]) => { withArgs.push(...ctes); return { select: () => chain }; },
    $count: (..._args: unknown[]) => Promise.resolve(5),
    refreshMaterializedView: (_view: unknown) => Promise.resolve('refreshed'),
    query: { amenity: { findFirst: async () => rows[0], findMany: async () => rows } },
    transaction: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  };
  const dollarWithThis: unknown[] = [];
  const db: RlsDatabase & Record<string, unknown> = {
    transaction: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
    execute: vi.fn(async () => []),
    query: tx.query,
    tables: { marker: true },
    // Mirrors PgDatabase.$with — builds a CTE alias, never executes SQL.
    $with(name: string) {
      dollarWithThis.push(this);
      return { as: (qb: unknown) => ({ __cte: name, qb }) };
    },
  } as never;
  return { db, tx, gucCalls, withArgs, dollarWithThis };
}

const GUCS = { 'app.tenant_id': 't1' };

describe('runWithGucs', () => {
  it('sets every GUC inside the tx in ONE statement before running fn', async () => {
    const { db, tx, gucCalls } = makeDb();
    const out = await runWithGucs(db, { a: '1', b: '2' }, async (t) => { expect(t).toBe(tx); return 'ok'; });
    expect(out).toBe('ok');
    // Both GUCs merged into a single `select set_config(...), set_config(...)`.
    expect(gucCalls.length).toBe(1);
    expect(gucCalls[0]![0]).toContain('set_config');
  });

  it('skips the set_config statement entirely for an empty GUC set', async () => {
    const { db, gucCalls } = makeDb();
    await runWithGucs(db, {}, async () => 'ok');
    expect(gucCalls.length).toBe(0);
  });
});

describe('createScopedDb', () => {
  it('replays deferred builder chains inside a GUC-set tx', async () => {
    const { db, gucCalls } = makeDb();
    const scoped = createScopedDb(db, GUCS) as unknown as { select(f?: unknown): { from(t: unknown): { where(w: unknown): Promise<unknown> } } };
    const result = await scoped.select({}).from('t').where('w');
    expect(result).toEqual([{ id: 'r1' }]);
    expect(gucCalls.length).toBe(1); // set_config ran first
  });

  it('covers all top-level builder methods (selectDistinct/with/$count regression)', () => {
    for (const m of [
      'select', 'selectDistinct', 'selectDistinctOn', 'insert', 'update', 'delete',
      'with', '$count', 'refreshMaterializedView',
    ]) {
      expect(QUERY_BUILDER_METHODS.has(m)).toBe(true);
    }
  });

  it('replays with() CTE chains inside the GUC transaction (RLS escape regression)', async () => {
    const { db, gucCalls, withArgs } = makeDb();
    const scoped = createScopedDb(db, GUCS) as unknown as {
      $with(name: string): { as(qb: unknown): unknown };
      with(...ctes: unknown[]): { select(): { from(t: unknown): { where(w: unknown): Promise<unknown> } } };
    };
    // $with never executes SQL — it passes through to the raw db and builds a
    // real alias usable by the replayed with().
    const cte = scoped.$with('sq').as({ q: 1 });
    expect(cte).toEqual({ __cte: 'sq', qb: { q: 1 } });
    expect(gucCalls.length).toBe(0); // no transaction opened by $with

    const result = await scoped.with(cte).select().from('t').where('w');
    expect(result).toEqual([{ id: 'r1' }]);
    expect(gucCalls.length).toBe(1); // set_config ran inside the replay tx
    expect(withArgs[0]).toBe(cte); // the recorded CTE reached tx.with()
  });

  it('binds $with to the raw db (this does not re-enter the proxy)', () => {
    const { db, dollarWithThis } = makeDb();
    const scoped = createScopedDb(db, GUCS) as unknown as { $with(name: string): { as(qb: unknown): unknown } };
    scoped.$with('sq').as({});
    expect(dollarWithThis[0]).toBe(db);
  });

  it('replays $count inside the GUC transaction (RLS escape regression)', async () => {
    const { db, gucCalls } = makeDb();
    const scoped = createScopedDb(db, GUCS) as unknown as { $count(t: unknown): PromiseLike<number> };
    const count = await scoped.$count('t');
    expect(count).toBe(5);
    expect(gucCalls.length).toBe(1);
  });

  it('replays refreshMaterializedView inside the GUC transaction', async () => {
    const { db, gucCalls } = makeDb();
    const scoped = createScopedDb(db, GUCS) as unknown as { refreshMaterializedView(v: unknown): PromiseLike<unknown> };
    const out = await scoped.refreshMaterializedView('mv');
    expect(out).toBe('refreshed');
    expect(gucCalls.length).toBe(1);
  });

  it('throws a clear error when a sync builder API is used on the deferred proxy', () => {
    const { db } = makeDb();
    const scoped = createScopedDb(db, GUCS) as unknown as { select(): Record<string, unknown> };
    const deferred = scoped.select();
    expect(() => deferred.toSQL).toThrow(/runWithGucs/);
    expect(() => deferred.prepare).toThrow(/synchronous builder API/);
    expect(() => deferred.as).toThrow(/deferred/);
  });

  it('wraps query namespace findFirst/findMany', async () => {
    const { db, gucCalls } = makeDb();
    const scoped = createScopedDb(db, GUCS);
    const row = await (scoped.query as Record<string, { findFirst(): Promise<unknown> }>).amenity!.findFirst();
    expect(row).toEqual({ id: 'r1' });
    expect(gucCalls.length).toBe(1);
  });

  it('wraps transaction() and execute(); passes through other props', async () => {
    const { db, gucCalls } = makeDb();
    const scoped = createScopedDb(db, GUCS);
    await scoped.transaction(async () => 'x');
    await scoped.execute('select 1');
    // 1 set_config from transaction() + 1 set_config + 1 replayed payload from execute()
    expect(gucCalls.length).toBe(3);
    expect((scoped as unknown as { tables: { marker: boolean } }).tables.marker).toBe(true);
  });

  it('caches the awaited chain result (no double execution)', async () => {
    const { db } = makeDb();
    const scoped = createScopedDb(db, GUCS) as unknown as { select(): { from(t: unknown): { where(w: unknown): PromiseLike<unknown> } } };
    const q = scoped.select().from('t').where('w');
    const [a, b] = [await q, await q];
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Pinned fast path — real Drizzle over a mock Pool, asserting the wire profile
// ---------------------------------------------------------------------------

describe('createScopedDb pinned fast path', () => {
  const marker = pgTable('marker', { id: pgText('id').primaryKey() });
  const schema = { marker };

  function makePinnedHarness(opts?: { failOn?: string }) {
    const texts: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (cfg: string | { text: string }, _params?: unknown[]) => {
        const text = typeof cfg === 'string' ? cfg : cfg.text;
        texts.push(text);
        if (opts?.failOn && text.startsWith(opts.failOn)) {
          throw new Error(`${opts.failOn} failed`);
        }
        return { rows: [], rowCount: 0, command: 'SELECT', fields: [] };
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const db = createDrizzle(schema, { pool });
    return { db, texts, release, client, pool };
  }

  it('runs a builder chain in exactly 3 round-trips: BEGIN+set_config packet, statement, COMMIT', async () => {
    const { db, texts, release } = makePinnedHarness();
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1' });
    const rows = await scoped.select().from(marker);
    expect(rows).toEqual([]);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe("BEGIN; SELECT set_config('app.tenant_id', 't1', true)");
    expect(texts[2]).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]).toEqual([]); // released clean
  });

  it('merges multiple GUCs into the single BEGIN packet', async () => {
    const { db, texts } = makePinnedHarness();
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1', 'app.role': 'member' });
    await scoped.select().from(marker);
    expect(texts[0]).toBe(
      "BEGIN; SELECT set_config('app.tenant_id', 't1', true), set_config('app.role', 'member', true)",
    );
  });

  it('escapes GUC values as literals in the packet', async () => {
    const { db, texts } = makePinnedHarness();
    const scoped = createScopedDb(db, { 'app.tenant_id': "o'brien" });
    await scoped.select().from(marker);
    expect(texts[0]).toBe("BEGIN; SELECT set_config('app.tenant_id', 'o''brien', true)");
  });

  it('wraps the relational query namespace through the pinned path', async () => {
    const { db, texts } = makePinnedHarness();
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1' });
    const rows = await scoped.query.marker!.findMany();
    expect(rows).toEqual([]);
    expect(texts[0]).toContain('BEGIN; SELECT set_config');
    expect(texts[texts.length - 1]).toBe('COMMIT');
  });

  it('ROLLBACKs, releases clean, and rethrows when the statement fails', async () => {
    const { db, texts, release } = makePinnedHarness({ failOn: 'select' });
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1' });
    // Drizzle wraps statement errors in DrizzleQueryError ("Failed query: …").
    await expect(async () => { await scoped.select().from(marker) }).rejects.toThrow('Failed query');
    expect(texts[texts.length - 1]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]).toEqual([]); // rollback succeeded → recycle
  });

  it('destroys the client and rethrows when COMMIT fails (silent-write-loss regression)', async () => {
    const { db, release } = makePinnedHarness({ failOn: 'COMMIT' });
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1' });
    await expect(async () => { await scoped.select().from(marker) }).rejects.toThrow('COMMIT failed');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeInstanceOf(Error); // destroyed
  });

  it('destroys the client when the BEGIN packet fails', async () => {
    const { db, release } = makePinnedHarness({ failOn: 'BEGIN' });
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1' });
    await expect(async () => { await scoped.select().from(marker) }).rejects.toThrow('BEGIN failed');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe('escapeGucLiteral', () => {
  it('quotes plain values', () => {
    expect(escapeGucLiteral('t1')).toBe("'t1'");
  });
  it('doubles single quotes', () => {
    expect(escapeGucLiteral("o'brien")).toBe("'o''brien'");
  });
  it('E-prefixes and escapes backslashes (standard_conforming_strings-proof)', () => {
    expect(escapeGucLiteral('a\\b')).toBe(" E'a\\\\b'");
  });
});

describe('withSystemMode', () => {
  it('applies the system-mode GUC (default app.system_mode)', async () => {
    const { db, gucCalls } = makeDb();
    await withSystemMode(db, async () => 'done');
    expect(gucCalls.length).toBe(1);
    expect(gucCalls[0]![0]).toContain('app.system_mode');
  });
});

// ---------------------------------------------------------------------------
// acquireScopedClient / releaseScopedClient
// ---------------------------------------------------------------------------

/** Mock PoolClient that records queries and can fail on a given statement prefix. */
function makeClient(opts?: { failOn?: string }) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (opts?.failOn && text.startsWith(opts.failOn)) {
        throw new Error(`${opts.failOn} failed`);
      }
      return {};
    }),
    release,
  };
  return { client: client as unknown as PoolClient, queries, release };
}

describe('acquireScopedClient', () => {
  it('BEGINs and applies all session vars in ONE packet, returns the createDb-built db', async () => {
    const { client, queries } = makeClient();
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const createDb = vi.fn((c: PoolClient) => ({ boundTo: c }));

    const out = await acquireScopedClient({
      pool,
      sessionVars: { 'app.tenant_id': 't1', 'app.role': 'member' },
      createDb,
    });

    // One combined round-trip: BEGIN + both set_configs, literals escaped.
    expect(queries.map((q) => q.text)).toEqual([
      "BEGIN; SELECT set_config('app.tenant_id', 't1', true), set_config('app.role', 'member', true)",
    ]);
    expect(queries[0]!.params).toBeUndefined();
    expect(createDb).toHaveBeenCalledWith(client, undefined);
    expect(out.client).toBe(client);
    expect(out.db).toEqual({ boundTo: client });
  });

  it('sends a bare BEGIN when there are no session vars', async () => {
    const { client, queries } = makeClient();
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    await acquireScopedClient({ pool, sessionVars: {}, createDb: vi.fn(() => ({})) });
    expect(queries.map((q) => q.text)).toEqual(['BEGIN']);
  });

  it('rolls back, destroys the client, and rethrows when the BEGIN packet fails', async () => {
    const { client, queries, release } = makeClient({ failOn: 'BEGIN' });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(
      acquireScopedClient({
        pool,
        sessionVars: { 'app.tenant_id': 't1' },
        createDb: vi.fn(),
      }),
    ).rejects.toThrow('BEGIN failed');

    expect(queries.map((q) => q.text)).toEqual([
      "BEGIN; SELECT set_config('app.tenant_id', 't1', true)",
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeInstanceOf(Error); // destroyed, not recycled
  });
});

describe('releaseScopedClient', () => {
  it('COMMITs and releases the client clean on success', async () => {
    const { client, queries, release } = makeClient();
    await releaseScopedClient({ client, commit: true });
    expect(queries.map((q) => q.text)).toEqual(['COMMIT']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]).toEqual([]); // released without error
  });

  it('ROLLBACKs and releases the client clean when commit=false', async () => {
    const { client, queries, release } = makeClient();
    await releaseScopedClient({ client, commit: false });
    expect(queries.map((q) => q.text)).toEqual(['ROLLBACK']);
    expect(release.mock.calls[0]).toEqual([]);
  });

  it('rethrows a COMMIT failure and destroys the client (silent-write-loss regression)', async () => {
    const { client, release } = makeClient({ failOn: 'COMMIT' });
    await expect(releaseScopedClient({ client, commit: true })).rejects.toThrow('COMMIT failed');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeInstanceOf(Error); // release WITH error → destroyed
  });

  it('swallows a ROLLBACK failure but still destroys the client', async () => {
    const { client, release } = makeClient({ failOn: 'ROLLBACK' });
    await expect(releaseScopedClient({ client, commit: false })).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe('assertSafeGucListValue / joinGucList', () => {
  it('accepts machine-generated ids and joins them', () => {
    expect(joinGucList(['org-1', 'org-2'])).toBe('org-1,org-2');
    expect(() => assertSafeGucListValue(['a-b_c', '123'])).not.toThrow();
  });

  it('rejects values containing a comma or single quote', () => {
    expect(() => assertSafeGucListValue(['ok', 'bad,ly'])).toThrow(/comma or single quote/);
    expect(() => joinGucList(["o'brien"])).toThrow(/comma or single quote/);
  });
});

describe('createGucScopeFactory', () => {
  interface Services {
    db: ReturnType<typeof makeDb>['db'];
    label: string;
  }

  function harness(enabled: boolean) {
    const { db: rawDb, gucCalls } = makeDb();
    const root = new IoC<Services>();
    root.register('db', () => rawDb);
    root.register('label', () => 'root');
    const factory = createGucScopeFactory<Services, { scopeId: string }>({
      container: root,
      enabled,
      gucs: ({ scopeId }) => ({ 'app.scope_id': scopeId }),
      seed: (scope, { scopeId }) => {
        scope.register('label', () => `seeded:${scopeId}`, ServiceLifetime.Scoped);
      },
    });
    return { factory, rawDb, gucCalls };
  }

  it('registers a GUC-scoped db override and runs seed', async () => {
    const { factory, rawDb, gucCalls } = harness(true);
    const scope = factory({ scopeId: 's1' });
    expect(scope.resolve('label')).toBe('seeded:s1');
    const scopedDb = scope.resolve('db');
    expect(scopedDb).not.toBe(rawDb); // proxied
    // Top-level op runs inside a transaction that applies the GUCs first.
    const chain = (scopedDb as unknown as { select(): { from(t: unknown): { where(w: unknown): Promise<unknown> } } }).select();
    await chain.from('t').where('w');
    expect(gucCalls.length).toBeGreaterThan(0);
    expect(gucCalls[0]?.[0]).toContain('app.scope_id');
  });

  it('skips the db override (raw db via parent chain) when disabled, but still seeds', () => {
    const { factory, rawDb } = harness(false);
    const scope = factory({ scopeId: 's2' });
    expect(scope.resolve('db')).toBe(rawDb);
    expect(scope.resolve('label')).toBe('seeded:s2');
  });

  it('creates isolated scopes per call', () => {
    const { factory } = harness(true);
    expect(factory({ scopeId: 'a' }).resolve('label')).toBe('seeded:a');
    expect(factory({ scopeId: 'b' }).resolve('label')).toBe('seeded:b');
  });
});

describe('createPinnedGucScopeFactory', () => {
  interface Services {
    db: ReturnType<typeof makeDb>['db'];
    label: string;
  }

  function harness(enabled: boolean, dbOverrides?: Partial<RlsDatabase>) {
    const made = makeDb();
    const rawDb = Object.assign(made.db, dbOverrides);
    const root = new IoC<Services>();
    root.register('db', () => rawDb);
    root.register('label', () => 'root');
    const factory = createPinnedGucScopeFactory<Services, { scopeId: string }>({
      container: root,
      enabled,
      gucs: ({ scopeId }) => ({ 'app.scope_id': scopeId }),
      seed: (scope, { scopeId }) => {
        scope.register('label', () => `seeded:${scopeId}`, ServiceLifetime.Scoped);
      },
    });
    return { factory, rawDb, tx: made.tx, gucCalls: made.gucCalls };
  }

  it('hands out the transaction-bound db with GUCs already applied', async () => {
    const { factory, tx, gucCalls } = harness(true);
    const scope = await factory({ scopeId: 's1' });
    // The scope db IS the transaction — not a proxy, not the raw db.
    expect(scope.resolve('db')).toBe(tx);
    // set_config went out before the factory resolved.
    expect(gucCalls.length).toBe(1);
    expect(gucCalls[0]![0]).toContain('app.scope_id');
    expect(scope.resolve('label')).toBe('seeded:s1');
    await scope.dispose({ commit: true });
  });

  it('commit-dispose completes the parked transaction exactly once', async () => {
    const txDone = vi.fn();
    const { factory } = harness(true, {
      transaction: (async (fn: (t: unknown) => Promise<unknown>) => {
        const made = makeDb();
        const out = await fn(made.tx);
        txDone();
        return out;
      }) as RlsDatabase['transaction'],
    });
    const scope = await factory({ scopeId: 's1' });
    expect(txDone).not.toHaveBeenCalled(); // parked while the scope lives
    await scope.dispose({ commit: true });
    expect(txDone).toHaveBeenCalledTimes(1);
  });

  it('rollback-dispose aborts the transaction without surfacing an error', async () => {
    const txCompleted = vi.fn();
    const { factory } = harness(true, {
      transaction: (async (fn: (t: unknown) => Promise<unknown>) => {
        const made = makeDb();
        const out = await fn(made.tx); // rejects on cb throw = drizzle ROLLBACK
        txCompleted();
        return out;
      }) as RlsDatabase['transaction'],
    });
    const scope = await factory({ scopeId: 's1' });
    await expect(scope.dispose({ commit: false })).resolves.toBeUndefined();
    expect(txCompleted).not.toHaveBeenCalled();
  });

  it('rejects at scope creation when BEGIN/set_config fails', async () => {
    const { factory } = harness(true, {
      transaction: (async () => {
        throw new Error('connect refused');
      }) as RlsDatabase['transaction'],
    });
    await expect(factory({ scopeId: 's1' })).rejects.toThrow('connect refused');
  });

  it('rethrows a COMMIT failure from commit-dispose, swallows it on rollback', async () => {
    const makeFailingCommit = () =>
      harness(true, {
        transaction: (async (fn: (t: unknown) => Promise<unknown>) => {
          const made = makeDb();
          try {
            await fn(made.tx);
          } catch (err) {
            throw err; // rollback path: propagate the abort marker
          }
          throw new Error('commit failed'); // COMMIT blew up after fn resolved
        }) as RlsDatabase['transaction'],
      });

    const committing = await makeFailingCommit().factory({ scopeId: 's1' });
    await expect(committing.dispose({ commit: true })).rejects.toThrow('commit failed');
  });

  it('skips the db override when disabled, still seeds, stays async', async () => {
    const { factory, rawDb } = harness(false);
    const scope = await factory({ scopeId: 's2' });
    expect(scope.resolve('db')).toBe(rawDb);
    expect(scope.resolve('label')).toBe('seeded:s2');
    await scope.dispose({ commit: true });
  });
});
