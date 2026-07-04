import { describe, it, expect, vi } from 'vitest';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createBaseTenantScopedCrudService, type CrudDatabase } from './index.ts';

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
  const db: CrudDatabase = {
    select: () => ({ from: () => ({ where: async () => [{ count: rows.length }] }) }),
    insert: () => ({ values: insertValues }),
    update: () => ({ set: (v: unknown) => { setArgs.push(v); return { where: () => ({ returning: updateReturning }) }; } }),
    delete: () => ({ where: () => ({ returning: updateReturning }) }),
    query: { amenity: { findMany: async () => rows, findFirst: async () => rows[0] } },
  };
  return { db, insertValues, setArgs };
}

const dateProvider = { now: () => new Date('2026-01-01T00:00:00Z') };

function makeService(rows: Array<Record<string, unknown>>, actorId?: string) {
  const { db, insertValues, setArgs } = makeDb(rows);
  const service = createBaseTenantScopedCrudService({
    db, dateProvider, tenantId: 't1', actorId,
    table: amenity, tableName: 'amenity', resourceName: 'amenity',
    mapToEntity: (r) => ({ id: r.id, name: r.name }),
  });
  return { service, insertValues, setArgs };
}

describe('createBaseTenantScopedCrudService', () => {
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

  it('create injects tenantId + audit columns when actor present', async () => {
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

  it('delete succeeds on match and 404s on miss', async () => {
    const ok = await makeService([{ id: 'wifi' }]).service.delete({ id: 'wifi' });
    expect(ok.ok).toBe(true);
    const miss = await makeService([]).service.delete({ id: 'x' });
    expect(!miss.ok && miss.error.key).toBe('amenity_not_found');
  });
});
