import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { IoC, ServiceLifetime } from '../../ioc/index.ts';
import {
  createScopedDb,
  createGucScopeFactory,
  assertSafeGucListValue,
  joinGucList,
  runWithGucs,
  withSystemMode,
  acquireScopedClient,
  releaseScopedClient,
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
  it('sets every GUC inside the tx before running fn', async () => {
    const { db, tx, gucCalls } = makeDb();
    const out = await runWithGucs(db, { a: '1', b: '2' }, async (t) => { expect(t).toBe(tx); return 'ok'; });
    expect(out).toBe('ok');
    expect(gucCalls.length).toBe(2);
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
  it('BEGINs, applies session vars, and returns the createDb-built db', async () => {
    const { client, queries } = makeClient();
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const createDb = vi.fn((c: PoolClient) => ({ boundTo: c }));

    const out = await acquireScopedClient({
      pool,
      sessionVars: { 'app.tenant_id': 't1', 'app.role': 'member' },
      createDb,
    });

    expect(queries.map((q) => q.text)).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'SELECT set_config($1, $2, true)',
    ]);
    expect(queries[1]!.params).toEqual(['app.tenant_id', 't1']);
    expect(queries[2]!.params).toEqual(['app.role', 'member']);
    expect(createDb).toHaveBeenCalledWith(client, undefined);
    expect(out.client).toBe(client);
    expect(out.db).toEqual({ boundTo: client });
  });

  it('rolls back, destroys the client, and rethrows when set_config fails', async () => {
    const { client, queries, release } = makeClient({ failOn: 'SELECT set_config' });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(
      acquireScopedClient({
        pool,
        sessionVars: { 'app.tenant_id': 't1' },
        createDb: vi.fn(),
      }),
    ).rejects.toThrow('SELECT set_config failed');

    expect(queries.map((q) => q.text)).toEqual(['BEGIN', 'SELECT set_config($1, $2, true)', 'ROLLBACK']);
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
