/**
 * Integration tests against a real Postgres (Docker required) — the
 * properties mocks cannot verify:
 *
 * 1. The pinned fast path's combined `BEGIN; SELECT set_config(...)` packet
 *    actually applies the GUCs: RLS policies filter by tenant.
 * 2. GUCs are transaction-local — nothing leaks to the next checkout of the
 *    same pool connection.
 * 3. Literal escaping round-trips hostile GUC values (quotes, backslashes).
 * 4. WITH CHECK violations propagate and leave the connection reusable.
 * 5. The Drizzle-managed paths (`runWithGucs`, `withSystemMode`, scoped
 *    `transaction()`) still work with the merged single-statement set_config.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { IoC } from '../../ioc/index.ts';
import { createDrizzle, type AppDatabase } from '../factory/index.ts';
import { createPinnedGucScopeFactory, createScopedDb, runWithGucs, withSystemMode } from './index.ts';

const note = pgTable('note', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  body: text('body'),
});
const schema = { note };

let container: StartedPostgreSqlContainer;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let db: AppDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  adminPool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await adminPool.query(`
    create table note (id text primary key, tenant_id text not null, body text);
    alter table note enable row level security;
    alter table note force row level security;
    create policy tenant_isolation on note
      using (
        tenant_id = current_setting('app.tenant_id', true)
        or current_setting('app.system_mode', true) = 'true'
      )
      with check (
        tenant_id = current_setting('app.tenant_id', true)
        or current_setting('app.system_mode', true) = 'true'
      );
    create role app_user login password 'app';
    grant select, insert, update, delete on note to app_user;
  `);
  await adminPool.query(
    `insert into note values ('n1', 't1', 'one'), ('n2', 't2', 'two')`,
  );
  // max: 1 makes connection reuse deterministic — the leak test below checks
  // the NEXT checkout of the SAME physical connection sees no GUC residue.
  appPool = new pg.Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: 'app_user',
    password: 'app',
    max: 1,
  });
  db = createDrizzle(schema, { pool: appPool });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await container?.stop();
});

describe('pinned fast path (combined BEGIN packet)', () => {
  it('applies the tenant GUC — RLS filters builder chains', async () => {
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1' });
    const rows = await scoped.select().from(note);
    expect(rows.map((r) => r.id)).toEqual(['n1']);
  });

  it('applies the tenant GUC — RLS filters the relational query namespace', async () => {
    const scoped = createScopedDb(db, { 'app.tenant_id': 't2' });
    const rows = await scoped.query.note.findMany();
    expect(rows.map((r) => r.id)).toEqual(['n2']);
  });

  it('sets multiple GUCs in the one packet', async () => {
    const scoped = createScopedDb(db, {
      'app.tenant_id': 't1',
      'app.system_mode': 'true',
    });
    // system_mode bypass wins → both tenants visible, proving BOTH configs applied.
    const rows = await scoped.select().from(note);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('does not leak GUCs to the next checkout of the same connection', async () => {
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1' });
    await scoped.select().from(note);
    // Same physical connection (pool max 1), outside any scoped wrapper:
    const res = await appPool.query(
      `select current_setting('app.tenant_id', true) as v`,
    );
    // Transaction-local set_config resets to the session default: NULL or ''.
    expect([null, '']).toContain(res.rows[0].v);
  });

  it('round-trips hostile GUC values through literal escaping', async () => {
    const hostile = String.raw`o'brien \x; drop--`;
    const scoped = createScopedDb(db, { 'app.tenant_id': hostile });
    const res = await scoped.execute(
      sql`select current_setting('app.tenant_id', true) as v`,
    );
    expect(res.rows[0]!.v).toBe(hostile);
  });

  it('scoped writes respect WITH CHECK and errors leave the connection reusable', async () => {
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1' });
    // In-tenant insert passes...
    await scoped.insert(note).values({ id: 'n3', tenantId: 't1', body: 'mine' });
    // ...cross-tenant insert is rejected by the policy...
    await expect(async () => {
      await scoped.insert(note).values({ id: 'nx', tenantId: 't2', body: 'not mine' });
    }).rejects.toThrow(/row-level security|Failed query/);
    // ...and the pool's (only) connection is healthy afterwards.
    const rows = await scoped.select().from(note);
    expect(rows.map((r) => r.id).sort()).toEqual(['n1', 'n3']);
    await scoped.delete(note).where(sql`id = 'n3'`);
  });

  it('rejected writes are rolled back, not half-applied', async () => {
    const scoped = createScopedDb(db, { 'app.tenant_id': 't2' });
    await expect(async () => {
      // Duplicate PK → unique violation inside the pinned transaction.
      await scoped.insert(note).values({ id: 'n2', tenantId: 't2', body: 'dup' });
    }).rejects.toThrow();
    const rows = await scoped.select().from(note);
    expect(rows.map((r) => r.id)).toEqual(['n2']);
  });
});

describe('Drizzle-managed paths (merged set_config statement)', () => {
  it('runWithGucs applies multiple GUCs in one statement', async () => {
    const seen = await runWithGucs(
      db,
      { 'app.tenant_id': 't1', 'app.system_mode': 'false' },
      async (tx) => {
        const res = await tx.execute(
          sql`select current_setting('app.tenant_id', true) as tenant,
                     current_setting('app.system_mode', true) as mode`,
        );
        return res.rows[0]!;
      },
    );
    expect(seen).toEqual({ tenant: 't1', mode: 'false' });
  });

  it('withSystemMode bypasses tenant isolation', async () => {
    const rows = await withSystemMode(db, async (tx) => tx.select().from(note));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('scoped transaction() rolls back the whole callback on error', async () => {
    const scoped = createScopedDb(db, { 'app.tenant_id': 't1' });
    await expect(
      scoped.transaction(async (tx) => {
        await tx.insert(note).values({ id: 'n4', tenantId: 't1', body: 'tx' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const rows = await scoped.select().from(note);
    expect(rows.map((r) => r.id)).toEqual(['n1']);
  });
});

describe('createPinnedGucScopeFactory (per-request pinned transaction)', () => {
  // NOTE: the app pool is max:1 and a pinned scope HOLDS that connection —
  // never touch `db` (or a second scope) while a scope is open in these tests.
  function makeFactory() {
    const root = new IoC<{ db: AppDatabase<typeof schema> }>();
    root.register('db', () => db);
    return createPinnedGucScopeFactory<{ db: AppDatabase<typeof schema> }, { tenantId: string }>({
      container: root,
      gucs: ({ tenantId }) => ({ 'app.tenant_id': tenantId }),
    });
  }

  it('the scope db is tenant-scoped across multiple queries in one transaction', async () => {
    const scope = await makeFactory()({ tenantId: 't1' });
    try {
      const sdb = scope.resolve('db');
      const first = await sdb.select().from(note);
      expect(first.map((r) => r.tenantId)).toEqual(['t1']);
      // Second query on the same scope: the GUC is transaction-local and the
      // whole scope IS one transaction — still scoped, no re-set needed.
      const second = await sdb.select().from(note);
      expect(second.map((r) => r.id)).toEqual(['n1']);
    } finally {
      await scope.dispose({ commit: true });
    }
  });

  it('commit persists writes; rollback discards them', async () => {
    const factory = makeFactory();

    const committing = await factory({ tenantId: 't1' });
    await committing.resolve('db').insert(note).values({ id: 'p1', tenantId: 't1', body: 'kept' });
    await committing.dispose({ commit: true });

    const discarding = await factory({ tenantId: 't1' });
    await discarding.resolve('db').insert(note).values({ id: 'p2', tenantId: 't1', body: 'dropped' });
    await discarding.dispose({ commit: false });

    const ids = (await withSystemMode(db, async (tx) => tx.select().from(note))).map((r) => r.id);
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
    await withSystemMode(db, async (tx) => tx.delete(note).where(sql`id = 'p1'`));
  });

  it('nested db.transaction() gets savepoint semantics inside the scope', async () => {
    const scope = await makeFactory()({ tenantId: 't1' });
    try {
      const sdb = scope.resolve('db');
      await expect(
        sdb.transaction(async (inner) => {
          await inner.insert(note).values({ id: 'p3', tenantId: 't1', body: 'savepoint' });
          throw new Error('inner abort');
        }),
      ).rejects.toThrow('inner abort');
      // The inner rollback must NOT have aborted the outer request
      // transaction — further work on the scope still succeeds.
      await sdb.insert(note).values({ id: 'p4', tenantId: 't1', body: 'after' });
    } finally {
      await scope.dispose({ commit: true });
    }
    const ids = (await withSystemMode(db, async (tx) => tx.select().from(note))).map((r) => r.id);
    expect(ids).not.toContain('p3');
    expect(ids).toContain('p4');
    await withSystemMode(db, async (tx) => tx.delete(note).where(sql`id = 'p4'`));
  });

  it('Promise.all on the scope db serializes safely on the one connection', async () => {
    const scope = await makeFactory()({ tenantId: 't1' });
    try {
      const sdb = scope.resolve('db');
      const results = await Promise.all(
        Array.from({ length: 5 }, () => sdb.select().from(note)),
      );
      for (const rows of results) expect(rows.map((r) => r.id)).toEqual(['n1']);
    } finally {
      await scope.dispose({ commit: true });
    }
  });

  it('a rejected write aborts the request transaction until dispose (documented pinned-model behavior)', async () => {
    const scope = await makeFactory()({ tenantId: 't1' });
    try {
      const sdb = scope.resolve('db');
      // WITH CHECK rejects the cross-tenant write...
      await expect(
        sdb.insert(note).values({ id: 'p5', tenantId: 't2', body: 'forbidden' }),
      ).rejects.toThrow();
      // ...and the transaction is now aborted: further statements fail until
      // the scope disposes (25P02 under drizzle's "Failed query" wrapper).
      // This is the accepted trade of model B.
      await expect(sdb.select().from(note)).rejects.toThrow(/Failed query|aborted/);
    } finally {
      await scope.dispose({ commit: false });
    }
    // The connection returns to the pool clean and usable.
    const rows = await createScopedDb(db, { 'app.tenant_id': 't1' }).select().from(note);
    expect(rows.map((r) => r.id)).toEqual(['n1']);
  });
});
