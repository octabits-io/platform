import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { setupTestDatabase, cleanupTestDatabase, resetDatabase } from './setup.ts';
import { testSchema, testItems, testTags } from '../test/test-schema.ts';

let db: NodePgDatabase<typeof testSchema>;

beforeAll(async () => {
  db = await setupTestDatabase({ schema: testSchema });
});

afterAll(async () => {
  await cleanupTestDatabase();
});

describe('setupTestDatabase', () => {
  it('returns a working Drizzle instance', async () => {
    const result = await db.execute(sql`SELECT 1 as num`);
    expect(result.rows[0]!.num).toBe(1);
  });

  it('has access to migrated tables', async () => {
    const items = await db.select().from(testItems);
    expect(items).toEqual([]);
  });
});

describe('resetDatabase', () => {
  beforeEach(async () => {
    // Reset tables before each test in this describe block
    await resetDatabase(db, [testTags, testItems]);
  });

  it('truncates all specified tables', async () => {
    // Insert some data
    await db.insert(testItems).values({ name: 'item-1', value: 10 });
    await db.insert(testItems).values({ name: 'item-2', value: 20 });

    let items = await db.select().from(testItems);
    expect(items).toHaveLength(2);

    // Reset
    await resetDatabase(db, [testTags, testItems]);

    items = await db.select().from(testItems);
    expect(items).toHaveLength(0);
  });

  it('resets identity sequences', async () => {
    // Insert and reset
    await db.insert(testItems).values({ name: 'first', value: 1 });
    await resetDatabase(db, [testTags, testItems]);

    // Next insert should get id=1 again
    const [inserted] = await db
      .insert(testItems)
      .values({ name: 'after-reset', value: 2 })
      .returning();

    expect(inserted!.id).toBe(1);
  });

  it('handles CASCADE for foreign key relationships', async () => {
    const [item] = await db.insert(testItems).values({ name: 'parent', value: 1 }).returning();
    await db.insert(testTags).values({ itemId: item!.id, tag: 'important' });

    // Truncate with CASCADE should work even though tags reference items
    await resetDatabase(db, [testTags, testItems]);

    const items = await db.select().from(testItems);
    const tags = await db.select().from(testTags);
    expect(items).toHaveLength(0);
    expect(tags).toHaveLength(0);
  });

  it('handles empty table list without error', async () => {
    await expect(resetDatabase(db, [])).resolves.toBeUndefined();
  });
});
