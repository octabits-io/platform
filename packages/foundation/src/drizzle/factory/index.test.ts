import { describe, it, expect } from 'vitest';
import { augmentDrizzle } from './drizzle.ts';

const schema = {
  users: { name: 'users' },
  posts: { name: 'posts' },
} as const;

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
});
