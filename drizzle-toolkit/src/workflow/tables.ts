import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';

export const workflowTable = pgTable('workflow', {
  id: serial('id').primaryKey(),
  tenantId: varchar('tenant_id', { length: 255 }).notNull(),
  type: varchar('type', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  input: jsonb('input'),
  output: jsonb('output'),
  error: text('error'),
  totalSteps: integer('total_steps').notNull().default(0),
  completedSteps: integer('completed_steps').notNull().default(0),
  failedSteps: integer('failed_steps').notNull().default(0),
  entityRef: varchar('entity_ref', { length: 255 }),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { mode: 'string' }),
  completedAt: timestamp('completed_at', { mode: 'string' }),
  updatedAt: timestamp('updated_at', { mode: 'string' }),
});

export const workflowStepTable = pgTable('workflow_step', {
  id: serial('id').primaryKey(),
  workflowId: integer('workflow_id')
    .notNull()
    .references(() => workflowTable.id),
  tenantId: varchar('tenant_id', { length: 255 }).notNull(),
  key: varchar('key', { length: 255 }).notNull(),
  type: varchar('type', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  dependencies: jsonb('dependencies').notNull().default([]),
  input: jsonb('input'),
  output: jsonb('output'),
  error: text('error'),
  startedAt: timestamp('started_at', { mode: 'string' }),
  completedAt: timestamp('completed_at', { mode: 'string' }),
});

export const WORKFLOW_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS workflow (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,
    type VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    input JSONB,
    output JSONB,
    error TEXT,
    total_steps INTEGER NOT NULL DEFAULT 0,
    completed_steps INTEGER NOT NULL DEFAULT 0,
    failed_steps INTEGER NOT NULL DEFAULT 0,
    entity_ref VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    updated_at TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflow_step (
    id SERIAL PRIMARY KEY,
    workflow_id INTEGER NOT NULL REFERENCES workflow(id),
    tenant_id VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL,
    type VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    dependencies JSONB NOT NULL DEFAULT '[]',
    input JSONB,
    output JSONB,
    error TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP
  );
`;
