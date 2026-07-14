import { describe, it, expect, vi } from 'vitest';
import { pgTable, text } from 'drizzle-orm/pg-core';
import {
  createDrizzleJobAuditStore,
  jobAuditColumns,
  type JobAuditRecord,
  type JobAuditStoreDatabase,
} from './index.ts';

// Real job-audit table: the reusable column-set + a consumer scope column.
const jobAuditLog = pgTable('job_audit_log', {
  ...jobAuditColumns,
  tenantId: text('tenant_id').notNull(),
});

// Single-scope deployment: same column-set, no scope column at all.
const unscopedJobAuditLog = pgTable('job_audit_log', { ...jobAuditColumns });

/** Mock Drizzle db capturing the values handed to `insert(...).values(...)`. */
function makeDb() {
  const insertValues = vi.fn(async () => {});
  const db: JobAuditStoreDatabase = { insert: () => ({ values: insertValues }) };
  return { db, insertValues };
}

const validRecord: JobAuditRecord = {
  queueName: 'email',
  jobId: 'job-1',
  jobType: 'email',
  status: 'dead_letter',
  errorMessage: 'Exhausted all retry attempts',
  completedAt: '2026-07-14T10:00:00.000Z',
  scopeKey: 't1',
  validPayload: true,
  payload: { to: 'a@example.com' },
  attemptCount: 3,
};

const invalidRecord: JobAuditRecord = {
  queueName: 'email',
  jobId: 'job-2',
  jobType: 'email',
  status: 'dead_letter',
  errorMessage: 'Payload failed schema validation; dead-lettered without retry',
  completedAt: '2026-07-14T10:05:00.000Z',
  scopeKey: 't1',
  validPayload: false,
  rawPayload: { nope: true },
  attemptCount: 1,
};

describe('createDrizzleJobAuditStore — record', () => {
  it('writes every audit field and stamps the scope from the record', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleJobAuditStore({
      db,
      table: jobAuditLog,
      scope: { column: 'tenantId' },
    });

    const result = await store.record(validRecord);
    expect(result.ok && result.value).toBe('recorded');
    expect(insertValues).toHaveBeenCalledWith({
      tenantId: 't1',
      jobId: 'job-1',
      queueName: 'email',
      jobType: 'email',
      status: 'dead_letter',
      payload: { to: 'a@example.com' },
      errorMessage: 'Exhausted all retry attempts',
      attemptCount: 3,
      completedAt: '2026-07-14T10:00:00.000Z',
    });
  });

  it('persists rawPayload for a schema-invalid record', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleJobAuditStore({ db, table: jobAuditLog, scope: { column: 'tenantId' } });

    const result = await store.record(invalidRecord);
    expect(result.ok && result.value).toBe('recorded');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { nope: true }, attemptCount: 1 }),
    );
  });

  it('writes a null payload through rather than dropping the column', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleJobAuditStore({ db, table: jobAuditLog, scope: { column: 'tenantId' } });

    await store.record({ ...invalidRecord, rawPayload: null });
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ payload: null }));
  });

  it('stamps no scope column when no scope is configured', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleJobAuditStore({ db, table: unscopedJobAuditLog });

    const result = await store.record(validRecord);
    expect(result.ok && result.value).toBe('recorded');
    // Even though the record carries a scopeKey, an unscoped store ignores it.
    expect(insertValues).toHaveBeenCalledWith(expect.not.objectContaining({ tenantId: 't1' }));
  });

  it('prefers a fixed scope value over the record scopeKey', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleJobAuditStore({
      db,
      table: jobAuditLog,
      scope: { column: 'tenantId', value: 'fixed' },
    });

    await store.record(validRecord); // record.scopeKey is 't1'
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'fixed' }));
  });

  it('skips an unscoped record when a scope column needs a value it cannot get', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleJobAuditStore({ db, table: jobAuditLog, scope: { column: 'tenantId' } });

    const { scopeKey: _omitted, ...systemRecord } = validRecord;
    const result = await store.record(systemRecord as JobAuditRecord);
    expect(result.ok && result.value).toBe('skipped_unscoped');
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('still writes an unscoped record when a fixed scope value is configured', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleJobAuditStore({
      db,
      table: jobAuditLog,
      scope: { column: 'tenantId', value: 'fixed' },
    });

    const { scopeKey: _omitted, ...systemRecord } = validRecord;
    const result = await store.record(systemRecord as JobAuditRecord);
    expect(result.ok && result.value).toBe('recorded');
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'fixed' }));
  });

  it('maps a throwing insert to job_audit_store_failure with job context', async () => {
    const { db } = makeDb();
    db.insert = () => ({ values: async () => { throw new Error('connection refused'); } });
    const store = createDrizzleJobAuditStore({ db, table: jobAuditLog, scope: { column: 'tenantId' } });

    const result = await store.record(validRecord);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('job_audit_store_failure');
      expect(result.error.message).toContain('job-1');
      expect(result.error.message).toContain('connection refused');
    }
  });
});

describe('createDrizzleJobAuditStore — onDlqAudit', () => {
  it('inserts the row and resolves void', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleJobAuditStore({ db, table: jobAuditLog, scope: { column: 'tenantId' } });

    // First arg is queue's QueueScope — this store ignores it.
    await expect(store.onDlqAudit({ resolve: () => {}, dispose: async () => {} }, validRecord))
      .resolves.toBeUndefined();
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }));
  });

  it('throws on a storage failure so defineQueue logs it rather than losing it silently', async () => {
    const { db } = makeDb();
    db.insert = () => ({ values: async () => { throw new Error('connection refused'); } });
    const store = createDrizzleJobAuditStore({ db, table: jobAuditLog, scope: { column: 'tenantId' } });

    await expect(store.onDlqAudit(null, validRecord)).rejects.toThrow('connection refused');
  });

  it('resolves quietly for a skipped unscoped record', async () => {
    const { db, insertValues } = makeDb();
    const store = createDrizzleJobAuditStore({ db, table: jobAuditLog, scope: { column: 'tenantId' } });

    const { scopeKey: _omitted, ...systemRecord } = validRecord;
    await expect(store.onDlqAudit(null, systemRecord as JobAuditRecord)).resolves.toBeUndefined();
    expect(insertValues).not.toHaveBeenCalled();
  });
});
