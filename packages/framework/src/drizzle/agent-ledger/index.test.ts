import { describe, expect, it, vi } from 'vitest';
import { PgDialect, pgTable, text } from 'drizzle-orm/pg-core';
import {
  agentLedgerColumns,
  createDrizzleAgentLedgerStore,
  createInMemoryAgentLedgerStore,
  type AgentLedgerEntryInput,
  type AgentLedgerStoreDatabase,
} from './index.ts';

const dialect = new PgDialect();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderSql = (where: unknown) => dialect.sqlToQuery(where as any).sql;

// Real ledger table: the reusable column-set + a consumer scope column.
const agentLedger = pgTable('agent_ledger', {
  ...agentLedgerColumns,
  tenantId: text('tenant_id').notNull(),
});
const unscopedLedger = pgTable('agent_ledger', { ...agentLedgerColumns });

const entry: AgentLedgerEntryInput = {
  principal: { kind: 'agent', id: 'ai:listing-fields', label: 'Listing fields', onBehalfOf: 'user-7', authorizationId: 'grant-3' },
  mode: 'reviewed',
  scope: 'listing:88',
  workflowId: 42,
  decision: { accepted: ['op-1'] },
  operations: [{ id: 'op-1', op: 'update', current: 'a', proposed: 'b' }],
  created: {},
  reversibility: 'reversible',
  scopeKey: 't1',
};

/**
 * Mock Drizzle db capturing insert values, update sets, and WHERE conditions;
 * `selectRows` seeds what the select chains resolve to.
 */
function makeDb(selectRows: Array<Record<string, unknown>> = []) {
  const insertValues = vi.fn();
  const returning = vi.fn(async () => [{ id: 1, ...insertValues.mock.calls[0]?.[0], appliedAt: '2026-09-03T10:00:00.000Z' }]);
  const updateSets: unknown[] = [];
  const whereArgs: unknown[] = [];
  const chain = {
    where: (w: unknown) => {
      whereArgs.push(w);
      return chain;
    },
    orderBy: () => chain,
    limit: async () => selectRows,
    then: (resolve: (rows: unknown[]) => void) => resolve(selectRows),
  };
  const db: AgentLedgerStoreDatabase = {
    select: () => ({ from: () => chain }),
    insert: () => ({ values: (v: unknown) => { insertValues(v); return { returning }; } }),
    update: () => ({ set: (s: unknown) => { updateSets.push(s); return { where: async (w: unknown) => { whereArgs.push(w); } }; } }),
  } as unknown as AgentLedgerStoreDatabase;
  return { db, insertValues, updateSets, whereArgs };
}

describe('createDrizzleAgentLedgerStore — record', () => {
  it('flattens the principal into columns, stamps the scope, and returns the stored row', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleAgentLedgerStore({ db, table: agentLedger, scope: { column: 'tenantId' } });

    const result = await store.record(entry);

    expect(insertValues).toHaveBeenCalledWith({
      tenantId: 't1',
      actorKind: 'agent',
      actorId: 'ai:listing-fields',
      actorLabel: 'Listing fields',
      onBehalfOf: 'user-7',
      authorizationId: 'grant-3',
      mode: 'reviewed',
      scope: 'listing:88',
      workflowId: '42',
      decision: { accepted: ['op-1'] },
      operations: entry.operations,
      created: {},
      reversibility: 'reversible',
    });
    expect(result.ok && result.value).toMatchObject({
      id: 1,
      principal: entry.principal,
      workflowId: '42',
      appliedAt: '2026-09-03T10:00:00.000Z',
      revertedAt: null,
    });
  });

  it('hands back ISO timestamps whatever text form the driver returned', async () => {
    const { db } = makeDb([
      { id: 5, actorKind: 'agent', actorId: 'a', mode: 'reviewed', scope: 's', workflowId: '42', operations: [], reversibility: 'reversible', appliedAt: '2026-09-03 18:13:11.096624+00', revertedAt: '2026-09-03 18:13:34.118+00' },
    ]);
    const store = createDrizzleAgentLedgerStore({ db, table: unscopedLedger });

    const found = await store.findByWorkflow(42);
    expect(found.ok && found.value?.appliedAt).toBe('2026-09-03T18:13:11.096Z');
    expect(found.ok && found.value?.revertedAt).toBe('2026-09-03T18:13:34.118Z');
  });

  it('refuses an entry it cannot scope instead of writing an ownerless row', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleAgentLedgerStore({ db, table: agentLedger, scope: { column: 'tenantId' } });

    const result = await store.record({ ...entry, scopeKey: undefined });

    expect(result.ok).toBe(false);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('with a fixed scope value, stamps it on writes and filters every read by it', async () => {
    const { db, insertValues, whereArgs } = makeDb([]);
    const store = createDrizzleAgentLedgerStore({ db, table: agentLedger, scope: { column: 'tenantId', value: 't9' } });

    await store.record({ ...entry, scopeKey: 'ignored' });
    expect(insertValues.mock.calls[0]?.[0]).toMatchObject({ tenantId: 't9' });

    await store.findByWorkflow(42);
    await store.listByActor('ai:listing-fields');
    await store.markReverted(1, { by: 'user-7', at: '2026-09-03T11:00:00.000Z' });
    for (const where of whereArgs) expect(renderSql(where)).toContain('"agent_ledger"."tenant_id" = ');
  });
});

describe('createDrizzleAgentLedgerStore — reads', () => {
  it('keeps the newest row per workflow, so a re-applied run supersedes its reverted application', async () => {
    const rows = [
      { id: 3, actorKind: 'agent', actorId: 'a', mode: 'reviewed', scope: 's', workflowId: '42', operations: [], reversibility: 'reversible', appliedAt: '2026-09-03T12:00:00Z', revertedAt: null },
      { id: 1, actorKind: 'agent', actorId: 'a', mode: 'reviewed', scope: 's', workflowId: '42', operations: [], reversibility: 'reversible', appliedAt: '2026-09-03T10:00:00Z', revertedAt: '2026-09-03T11:00:00Z', revertedBy: 'u' },
      { id: 2, actorKind: 'agent', actorId: 'a', mode: 'autopilot', scope: 's', workflowId: '43', operations: [], reversibility: 'compensable', appliedAt: '2026-09-03T10:30:00Z', revertedAt: null },
    ];
    const { db } = makeDb(rows);
    const store = createDrizzleAgentLedgerStore({ db, table: unscopedLedger });

    const found = await store.findByWorkflows([42, 43, 44]);
    expect(found.ok && [...found.value.keys()].sort()).toEqual(['42', '43']);
    expect(found.ok && found.value.get('42')?.id).toBe(3);
    expect(found.ok && found.value.get('42')?.created).toEqual({});
    expect(found.ok && found.value.get('43')?.mode).toBe('autopilot');
  });

  it('marks a row reverted with who and when, never deleting it', async () => {
    const { db, updateSets } = makeDb();
    const store = createDrizzleAgentLedgerStore({ db, table: unscopedLedger });

    const result = await store.markReverted(7, { by: 'user-7', at: '2026-09-03T11:00:00.000Z' });

    expect(result.ok).toBe(true);
    expect(updateSets).toEqual([{ revertedAt: '2026-09-03T11:00:00.000Z', revertedBy: 'user-7' }]);
  });
});

describe('createInMemoryAgentLedgerStore', () => {
  it('behaves like the Drizzle store: append, latest per workflow, per-actor timeline, revert marks', async () => {
    const store = createInMemoryAgentLedgerStore();
    const first = await store.record({ ...entry, appliedAt: '2026-09-03T10:00:00.000Z' });
    const other = await store.record({ ...entry, workflowId: 43, principal: { kind: 'user', id: 'user-7' }, mode: 'manual', appliedAt: '2026-09-03T10:30:00.000Z' });
    if (!first.ok || !other.ok) throw new Error('record failed');

    await store.markReverted(first.value.id, { by: 'user-7', at: '2026-09-03T11:00:00.000Z' });
    const second = await store.record({ ...entry, appliedAt: '2026-09-03T12:00:00.000Z' });
    if (!second.ok) throw new Error('record failed');

    const byWorkflow = await store.findByWorkflow(42);
    expect(byWorkflow.ok && byWorkflow.value?.id).toBe(second.value.id);
    expect(byWorkflow.ok && byWorkflow.value?.revertedAt).toBeNull();

    const reverted = await store.get(first.value.id);
    expect(reverted.ok && reverted.value?.revertedBy).toBe('user-7');

    const timeline = await store.listByActor('ai:listing-fields');
    expect(timeline.ok && timeline.value.map((e) => e.id)).toEqual([second.value.id, first.value.id]);

    const many = await store.findByWorkflows([42, 43]);
    expect(many.ok && many.value.get('43')?.principal).toEqual({ kind: 'user', id: 'user-7' });
  });
});
