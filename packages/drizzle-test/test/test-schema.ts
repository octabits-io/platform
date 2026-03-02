import { pgTable, serial, varchar, integer, timestamp } from 'drizzle-orm/pg-core';

export const testItems = pgTable('test_items', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  value: integer('value').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const testTags = pgTable('test_tags', {
  id: serial('id').primaryKey(),
  itemId: integer('item_id')
    .notNull()
    .references(() => testItems.id),
  tag: varchar('tag', { length: 255 }).notNull(),
});

export const testSchema = { testItems, testTags };
