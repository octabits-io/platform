import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { augmentDrizzle } from './drizzle.ts';

const schema = {
  users: { name: 'users' },
  posts: { name: 'posts' },
} as const;

/**
 * Minimal stand-in for a pg Pool: enough for Drizzle to open a transaction and
 * issue `begin` / `savepoint` / `commit` without a database. The constructor
 * name matters — Drizzle's node-postgres session branches on
 * `constructor.name.includes('Pool')` to decide whether to `connect()`.
 */
class FakePool {
  readonly statements: string[] = [];

  async query(text: string | { text: string }) {
    this.statements.push(typeof text === 'string' ? text : text.text);
    return { rows: [], fields: [], rowCount: 0 };
  }

  async connect() {
    const self = this;
    return {
      query: (text: string | { text: string }) => self.query(text),
      release() {},
    };
  }
}

describe('augmentDrizzle', () => {
  it('attaches .tables and .schema pointing at the passed schema', () => {
    const base = {};
    const db = augmentDrizzle(base, schema);
    expect(db.tables).toBe(schema);
    expect(db.schema).toBe(schema);
  });

  it('mutates and returns the same instance', () => {
    const base = {};
    const db = augmentDrizzle(base, schema);
    expect(db).toBe(base);
  });

  it('leaves objects without a transaction() untouched apart from augmentation', () => {
    const base: Record<string, unknown> = {};
    const db = augmentDrizzle(base, schema);
    expect(typeof (db as any).transaction).toBe('undefined');
  });

  it('rewraps transaction() so the tx handed to the callback is also augmented', async () => {
    // A fake tx that itself has no augmentation until the wrapper adds it.
    const innerTx: Record<string, unknown> = { marker: 'tx' };
    const base = {
      transaction(cb: (tx: any) => Promise<unknown>) {
        return cb(innerTx);
      },
    };

    const db = augmentDrizzle(base, schema);

    let received: any;
    await db.transaction(async (tx: any) => {
      received = tx;
      return undefined;
    });

    expect(received).toBe(innerTx);
    expect(received.tables).toBe(schema);
    expect(received.schema).toBe(schema);
    expect(received.marker).toBe('tx');
  });

  it('forwards extra transaction() args (e.g. config) to the original', async () => {
    const seen: unknown[] = [];
    const base = {
      transaction(cb: (tx: any) => Promise<unknown>, config?: unknown) {
        seen.push(config);
        return cb({});
      },
    };

    const db = augmentDrizzle(base, schema);
    const config = { isolationLevel: 'serializable' };
    await (db as any).transaction(async () => undefined, config);

    expect(seen).toEqual([config]);
  });

  it('augments nested transactions recursively', async () => {
    const level2: Record<string, unknown> = { level: 2 };
    const level1: Record<string, unknown> = {
      level: 1,
      transaction(cb: (tx: any) => Promise<unknown>) {
        return cb(level2);
      },
    };
    const base = {
      transaction(cb: (tx: any) => Promise<unknown>) {
        return cb(level1);
      },
    };

    const db = augmentDrizzle(base, schema);

    let deepest: any;
    await db.transaction(async (tx1: any) => {
      // tx1 is augmented, and its own transaction() is rewrapped too.
      await tx1.transaction(async (tx2: any) => {
        deepest = tx2;
        return undefined;
      });
      return undefined;
    });

    expect(deepest.tables).toBe(schema);
    expect(deepest.schema).toBe(schema);
    expect(deepest.level).toBe(2);
  });

  it('leaves a schema the target already owns in place, but still sets .tables', () => {
    // Stands in for Drizzle's PgTransaction, which owns `schema` (its
    // RelationalSchemaConfig) and feeds it to nested transactions.
    const ownSchema = { fullSchema: {}, schema: {}, tableNamesMap: {} };
    const tx = { schema: ownSchema };

    const augmented = augmentDrizzle(tx, schema);

    expect(augmented.tables).toBe(schema);
    expect(augmented.schema).toBe(ownSchema);
  });
});

describe('augmentDrizzle over real Drizzle instances', () => {
  const users = pgTable('users', { id: serial('id').primaryKey(), name: text('name') });
  const realSchema = { users };

  function makeDb() {
    const pool = new FakePool();
    const db = augmentDrizzle(
      drizzle({ client: pool as never, schema: realSchema }),
      realSchema,
    );
    return { db: db as never as Record<string, any>, pool };
  }

  it('keeps the relational query API on a nested transaction', async () => {
    const { db, pool } = makeDb();

    expect(db.query.users).toBeDefined();

    let level1: any;
    let level2: any;
    await db.transaction(async (tx1: any) => {
      level1 = tx1;
      await tx1.transaction(async (tx2: any) => {
        level2 = tx2;
      });
    });

    // Regression: `augmentDrizzle` used to overwrite `PgTransaction.schema`
    // with the schema module, so the savepoint transaction was constructed
    // with no relational config and came back with `query === {}`. Anything
    // calling `tx.query.*` one level down died on `undefined`.
    expect(level1.query.users).toBeDefined();
    expect(level2.query.users).toBeDefined();

    // And the nested tx really was a savepoint, not a no-op.
    expect(pool.statements.some(s => s.includes('savepoint'))).toBe(true);
  });

  it('still augments both levels with .tables', async () => {
    const { db } = makeDb();

    let level2: any;
    await db.transaction(async (tx1: any) => {
      expect(tx1.tables).toBe(realSchema);
      await tx1.transaction(async (tx2: any) => {
        level2 = tx2;
      });
    });

    expect(level2.tables).toBe(realSchema);
  });
});
