import { describe, it, expect, vi } from 'vitest';
import { PgDialect, pgTable, text } from 'drizzle-orm/pg-core';
import { encryptionKeyColumns } from '../scope/index.ts';
import {
  createDrizzleScopedKeyStore,
  type ScopedKeyStoreDatabase,
} from './index.ts';

/** Render a captured Drizzle SQL condition to its Postgres text. */
const dialect = new PgDialect();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderSql = (where: unknown) => dialect.sqlToQuery(where as any).sql;

// Real encryption-key table: the reusable column-set + a unique scope column.
const encryptionKey = pgTable('encryption_key', {
  ...encryptionKeyColumns,
  tenantId: text('tenant_id').notNull().unique(),
});

const scope = { column: 'tenantId', value: 't1' };

/**
 * Mock Drizzle db capturing insert values, select fields, and the WHERE
 * condition; `selectRows` seeds what the select chain resolves to.
 */
function makeDb(selectRows: Array<Record<string, unknown>> = []) {
  const insertValues = vi.fn(async () => {});
  const deleteWhereArgs: unknown[] = [];
  const selectFields: unknown[] = [];
  const selectWhereArgs: unknown[] = [];
  const limitArgs: number[] = [];
  const db: ScopedKeyStoreDatabase = {
    select: (fields) => {
      selectFields.push(fields);
      return {
        from: () => ({
          where: (w: unknown) => {
            selectWhereArgs.push(w);
            return {
              limit: async (n: number) => { limitArgs.push(n); return selectRows; },
            };
          },
        }),
      };
    },
    insert: () => ({ values: insertValues }),
    delete: () => ({ where: async (w: unknown) => { deleteWhereArgs.push(w); } }),
  };
  return { db, insertValues, deleteWhereArgs, selectFields, selectWhereArgs, limitArgs };
}

const sampleRow = {
  recipient: 'age1recipient',
  identityEncrypted: Buffer.from('AGE-SECRET-KEY-1X'),
  blindIndexKeyEncrypted: Buffer.from('deadbeef'),
};

describe('createDrizzleScopedKeyStore — insert', () => {
  it('stamps the scope column alongside the row fields', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.insert(sampleRow);
    expect(result.ok).toBe(true);
    expect(insertValues).toHaveBeenCalledWith({
      tenantId: 't1',
      recipient: 'age1recipient',
      identityEncrypted: sampleRow.identityEncrypted,
      blindIndexKeyEncrypted: sampleRow.blindIndexKeyEncrypted,
    });
  });

  it('maps a 23505 in the cause chain to scoped_key_store_conflict', async () => {
    const { db } = makeDb();
    const uniqueViolation = new Error('duplicate key value violates constraint', {
      cause: Object.assign(new Error('driver error'), { code: '23505' }),
    });
    db.insert = () => ({ values: async () => { throw uniqueViolation; } });
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.insert(sampleRow);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_store_conflict');
  });

  it('maps a plain error to scoped_key_store_failure', async () => {
    const { db } = makeDb();
    db.insert = () => ({ values: async () => { throw new Error('connection refused'); } });
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.insert(sampleRow);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_store_failure');
  });

  it('treats a cause chain deeper than 10 as failure, not conflict', async () => {
    const { db } = makeDb();
    // Bury the 23505 under 11 wrapper layers — beyond the bounded walk.
    let deep: { code?: string; cause?: unknown } = { code: '23505' };
    for (let i = 0; i < 11; i++) deep = { cause: deep };
    db.insert = () => ({ values: async () => { throw deep; } });
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.insert(sampleRow);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_store_failure');
  });
});

describe('createDrizzleScopedKeyStore — find', () => {
  it('renders the scope predicate + limit 1 and maps the four row fields', async () => {
    const persisted = { ...sampleRow, keyVersion: 7 };
    const { db, selectFields, selectWhereArgs, limitArgs } = makeDb([persisted]);
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.find();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        recipient: 'age1recipient',
        identityEncrypted: sampleRow.identityEncrypted,
        blindIndexKeyEncrypted: sampleRow.blindIndexKeyEncrypted,
        keyVersion: 7,
      });
    }
    // Selects exactly the four seam fields.
    expect(Object.keys(selectFields[0] as object).sort()).toEqual(
      ['blindIndexKeyEncrypted', 'identityEncrypted', 'keyVersion', 'recipient'],
    );
    expect(renderSql(selectWhereArgs[0])).toContain('"tenant_id" =');
    expect(limitArgs[0]).toBe(1);
  });

  it('returns ok(null) on empty result', async () => {
    const { db } = makeDb([]);
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.find();
    expect(result.ok && result.value).toBe(null);
  });

  it('wraps a throwing select into scoped_key_store_failure', async () => {
    const { db } = makeDb();
    db.select = () => { throw new Error('boom-select'); };
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.find();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('scoped_key_store_failure');
  });
});

describe('createDrizzleScopedKeyStore — exists', () => {
  it('selects only the id column and reports presence', async () => {
    const { db, selectFields } = makeDb([{ id: 1 }]);
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.exists();
    expect(result.ok && result.value).toBe(true);
    expect(Object.keys(selectFields[0] as object)).toEqual(['id']);
  });

  it('reports absence when no row matches', async () => {
    const { db } = makeDb([]);
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.exists();
    expect(result.ok && result.value).toBe(false);
  });
});

describe('createDrizzleScopedKeyStore — destroy', () => {
  it('deletes scoped by the scope predicate', async () => {
    const { db, deleteWhereArgs } = makeDb();
    const store = createDrizzleScopedKeyStore({ db, table: encryptionKey, scope });

    const result = await store.destroy();
    expect(result.ok).toBe(true);
    expect(renderSql(deleteWhereArgs[0])).toContain('"tenant_id" =');
  });
});

describe('createDrizzleScopedKeyStore — withDb', () => {
  it('issues against the transaction db with the same stamping', async () => {
    const main = makeDb();
    const tx = makeDb();
    const store = createDrizzleScopedKeyStore({ db: main.db, table: encryptionKey, scope });

    const result = await store.withDb(tx.db).insert(sampleRow);
    expect(result.ok).toBe(true);
    // The write landed on the tx db, not the main db.
    expect(tx.insertValues).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }));
    expect(main.insertValues).not.toHaveBeenCalled();
  });
});
