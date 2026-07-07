import { describe, it, expect, vi } from 'vitest';
import { PgDialect, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  createBaseCrudService,
  createScopedCrudService,
  type CrudDatabase,
} from './index.ts';

/** Render a captured Drizzle SQL condition to its Postgres text. */
const dialect = new PgDialect();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderSql = (where: unknown) => dialect.sqlToQuery(where as any).sql;

const amenity = pgTable('amenity', {
  id: text().primaryKey().notNull(),
  tenantId: text('tenant_id').notNull(),
  name: text().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
});

function makeDb(rows: Array<Record<string, unknown>>) {
  const insertValues = vi.fn(async () => {});
  const updateReturning = vi.fn(async () => rows.length ? [{ id: rows[0]!.id }] : []);
  const setArgs: unknown[] = [];
  const whereArgs: unknown[] = [];
  const findManyArgs: unknown[] = [];
  // The count query is awaited directly when unscoped (no .where chained), so
  // from() returns a promise that also carries a .where.
  const countRows = [{ count: rows.length }];
  const fromResult = () => Object.assign(Promise.resolve(countRows), {
    where: async (w: unknown) => { whereArgs.push(w); return countRows; },
  });
  const updateWhereArgs: unknown[] = [];
  const db: CrudDatabase = {
    select: () => ({ from: fromResult }),
    insert: () => ({ values: insertValues }),
    update: () => ({ set: (v: unknown) => { setArgs.push(v); return { where: (w: unknown) => { updateWhereArgs.push(w); return { returning: updateReturning }; } }; } }),
    delete: () => ({ where: () => ({ returning: updateReturning }) }),
    query: {
      amenity: {
        findMany: async (opts: unknown) => { findManyArgs.push(opts); return rows; },
        findFirst: async () => rows[0],
      },
    },
  };
  return { db, insertValues, setArgs, whereArgs, updateWhereArgs, findManyArgs };
}

const dateProvider = { now: () => new Date('2026-01-01T00:00:00Z') };

function makeService(rows: Array<Record<string, unknown>>, actorId?: string) {
  const { db, insertValues, setArgs, updateWhereArgs } = makeDb(rows);
  const service = createScopedCrudService({
    db, dateProvider, scope: { column: 'tenantId', value: 't1' }, actorId,
    table: amenity, tableName: 'amenity', resourceName: 'amenity',
    mapToEntity: (r) => ({ id: r.id, name: r.name }),
  });
  return { service, insertValues, setArgs, updateWhereArgs };
}

describe('createScopedCrudService (bound scope)', () => {
  it('list returns mapped items + total', async () => {
    const { service } = makeService([{ id: 'wifi', name: 'WiFi' }]);
    const r = await service.list();
    expect(r.ok && r.value).toEqual({ items: [{ id: 'wifi', name: 'WiFi' }], total: 1 });
  });

  it('getById maps hit and returns keyed not-found on miss', async () => {
    const hit = await makeService([{ id: 'wifi', name: 'WiFi' }]).service.getById({ id: 'wifi' });
    expect(hit.ok && hit.value).toEqual({ id: 'wifi', name: 'WiFi' });
    const miss = await makeService([]).service.getById({ id: 'x' });
    expect(!miss.ok && miss.error.key).toBe('amenity_not_found');
  });

  it('create injects the scope column + audit columns when actor present', async () => {
    const { service, insertValues } = makeService([], 'user-9');
    const r = await service.create({ id: 'wifi', name: 'WiFi' });
    expect(r.ok).toBe(true);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', createdBy: 'user-9', updatedBy: 'user-9',
    }));
  });

  it('update stamps updatedAt/updatedBy and 404s when no row matched', async () => {
    const { service, setArgs } = makeService([{ id: 'wifi' }], 'user-9');
    const ok = await service.update({ id: 'wifi', name: 'New' });
    expect(ok.ok).toBe(true);
    expect(setArgs[0]).toMatchObject({ name: 'New', updatedBy: 'user-9', updatedAt: dateProvider.now() });
    const miss = await makeService([]).service.update({ id: 'x', name: 'n' });
    expect(!miss.ok && miss.error.key).toBe('amenity_not_found');
  });

  it('update strips the scope column from the payload (scope-transfer regression)', async () => {
    const { service, setArgs } = makeService([{ id: 'wifi' }]);
    const r = await service.update({
      id: 'wifi', name: 'New',
      // A hostile/buggy caller smuggling the scope column past the type layer:
      tenantId: 'other-tenant',
    } as never);
    expect(r.ok).toBe(true);
    expect(setArgs[0]).not.toHaveProperty('tenantId');
    expect(setArgs[0]).toMatchObject({ name: 'New' });
  });

  it('update WHERE carries the scope predicate (rendered SQL)', async () => {
    const { service, updateWhereArgs } = makeService([{ id: 'wifi' }]);
    await service.update({ id: 'wifi', name: 'New' });
    const sql = renderSql(updateWhereArgs[0]);
    expect(sql).toContain('"id" =');
    expect(sql).toContain('"tenant_id" =');
  });

  it('delete succeeds on match and 404s on miss', async () => {
    const ok = await makeService([{ id: 'wifi' }]).service.delete({ id: 'wifi' });
    expect(ok.ok).toBe(true);
    const miss = await makeService([]).service.delete({ id: 'x' });
    expect(!miss.ok && miss.error.key).toBe('amenity_not_found');
  });
});

describe('createBaseCrudService (unscoped)', () => {
  it('list queries without any where clause and create injects no scope column', async () => {
    const { db, insertValues, findManyArgs } = makeDb([{ id: 'wifi', name: 'WiFi' }]);
    const service = createBaseCrudService({
      db, dateProvider,
      table: amenity, tableName: 'amenity', resourceName: 'amenity',
      mapToEntity: (r) => ({ id: r.id, name: r.name }),
    });

    const r = await service.list();
    expect(r.ok && r.value).toEqual({ items: [{ id: 'wifi', name: 'WiFi' }], total: 1 });
    expect(findManyArgs[0]).not.toHaveProperty('where');

    const c = await service.create({ id: 'wifi', tenantId: 'explicit', name: 'WiFi' });
    expect(c.ok).toBe(true);
    // Unscoped: caller-supplied values pass through untouched, nothing injected.
    expect(insertValues).toHaveBeenCalledWith({ id: 'wifi', tenantId: 'explicit', name: 'WiFi' });
  });
});

describe('createScopedCrudService (generic scope column)', () => {
  it('scopes queries by the configured column and injects it on create', async () => {
    const { db, insertValues, findManyArgs } = makeDb([{ id: 'wifi', name: 'WiFi' }]);
    const service = createScopedCrudService({
      db, dateProvider,
      scope: { column: 'tenantId', value: 'ws-7' },
      table: amenity, tableName: 'amenity', resourceName: 'amenity',
      mapToEntity: (r) => ({ id: r.id, name: r.name }),
    });

    const r = await service.list();
    expect(r.ok && r.value.total).toBe(1);
    expect(findManyArgs[0]).toHaveProperty('where');

    const c = await service.create({ id: 'wifi', name: 'WiFi' });
    expect(c.ok).toBe(true);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'ws-7' }));
  });
});
