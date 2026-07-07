import { describe, it, expect, vi } from 'vitest';
import { createScopedDb, runWithGucs, withSystemMode, QUERY_BUILDER_METHODS, type RlsDatabase } from './index.ts';

/** Fake db whose transaction records executed set_config GUCs. */
function makeDb() {
  const gucCalls: string[][] = [];
  const rows = [{ id: 'r1' }];
  const chain = { from: () => chain, where: () => Promise.resolve(rows) };
  const tx = {
    execute: vi.fn(async (q: { queryChunks?: unknown[] } | string) => { gucCalls.push([JSON.stringify(q)]); return []; }),
    select: () => chain,
    selectDistinct: () => chain,
    insert: () => ({ values: async () => rows }),
    query: { amenity: { findFirst: async () => rows[0], findMany: async () => rows } },
    transaction: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  };
  const db: RlsDatabase & Record<string, unknown> = {
    transaction: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
    execute: vi.fn(async () => []),
    query: tx.query,
    tables: { marker: true },
  } as never;
  return { db, tx, gucCalls };
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

  it('covers all top-level builder methods (selectDistinct regression)', () => {
    for (const m of ['select', 'selectDistinct', 'selectDistinctOn', 'insert', 'update', 'delete']) {
      expect(QUERY_BUILDER_METHODS.has(m)).toBe(true);
    }
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
