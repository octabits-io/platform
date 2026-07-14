/**
 * @octabits-io/framework/drizzle/job-audit-store — the Drizzle adapter behind
 * `@octabits-io/framework/queue`'s structural `onDlqAudit` sink.
 *
 * `@octabits-io/framework/queue` owns dead-letter handling but bakes in no table
 * schema: `defineQueue` hands each dead-lettered job to an injected
 * `onDlqAudit(scope, record)` and lets the consumer decide how (and whether) to
 * persist it. This module is the Postgres/Drizzle implementation of that seam —
 * so queue needs no `drizzle-orm` peer, and the ORM query logic lives in the
 * package that already owns Drizzle.
 *
 * The record types here are **structural duplicates** of queue's (same shape,
 * no import) — the same decoupling `@octabits-io/framework/drizzle/scoped-key-store`
 * uses for pii's `ScopedKeyStore` seam. `store.onDlqAudit` plugs straight into
 * `defineQueue({ onDlqAudit })`; the duplicated record type is deliberately
 * *wider* than queue's generic one (`payload: unknown`), so any
 * `DlqAuditRecord<TPayload>` is accepted.
 *
 * Build the table from {@link jobAuditColumns} plus your own scope column, if
 * any. See {@link createDrizzleJobAuditStore} for the scoping rules.
 */
import { bigserial, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { jsonbSafe } from '../scope/index.ts';
import { type OctError, type Result, ok, err } from '../../result/index.ts';

// ---------------------------------------------------------------------------
// Column-set (extension mechanism)
// ---------------------------------------------------------------------------

/**
 * Generic job-audit columns — one row per audited job. The **scope-reference
 * column is intentionally not part of the set**: declare it yourself so you own
 * its name, type, FK, and nullability, and omit it entirely in a single-scope
 * deployment.
 *
 * ```ts
 * import { pgTable, text, index, foreignKey } from 'drizzle-orm/pg-core';
 * import { jobAuditColumns } from '@octabits-io/framework/drizzle/job-audit-store';
 *
 * export const jobAuditLog = pgTable(
 *   'job_audit_log',
 *   {
 *     ...jobAuditColumns,
 *     tenantId: text('tenant_id').notNull(), // your scope column
 *   },
 *   (t) => [
 *     foreignKey({ columns: [t.tenantId], foreignColumns: [tenant.id], name: 'job_audit_log_tenant_id_fk' }),
 *     index('job_audit_log_queue_name_idx').on(t.queueName),
 *   ],
 * );
 * ```
 *
 * `status` is a plain `text` rather than a narrowed `$type<...>()`: this store
 * only ever writes `'dead_letter'`, but consumers commonly reuse the same table
 * for in-flight job states (`'running'`, `'completed'`, …). Narrow it yourself
 * with `.$type<YourStatus>()` if you want that union enforced.
 */
export const jobAuditColumns = {
  id: bigserial({ mode: 'number' }).primaryKey().notNull(),
  /** Queue-system job id (pg-boss). Not unique — a job may be audited more than once. */
  jobId: text('job_id').notNull(),
  /** Name of the queue the job belonged to. */
  queueName: text('queue_name').notNull(),
  /** Job type — mirrors `queueName` for single-type queues. */
  jobType: text('job_type').notNull(),
  /** Terminal or in-flight status. This store writes `'dead_letter'`. */
  status: text().notNull(),
  /**
   * The job payload as audited. Nullable — a job may carry none.
   *
   * `jsonbSafe` (not stock `jsonb()`): a schema-invalid payload is an arbitrary
   * `unknown`, so it can be a top-level JSON *string* — exactly the value stock
   * `jsonb()` re-parses and silently retypes on read (`"73235"` → `73235`).
   */
  payload: jsonbSafe(),
  /** Human-readable reason the job was audited (e.g. why it was dead-lettered). */
  errorMessage: text('error_message'),
  /** Attempts made before the job reached this status. */
  attemptCount: integer('attempt_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
  /** When the job reached its terminal status. */
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
};

// ---------------------------------------------------------------------------
// Structural duplicates of queue's DLQ audit record
// ---------------------------------------------------------------------------

/** Fields common to every {@link JobAuditRecord}, regardless of payload validity. */
export interface JobAuditRecordBase {
  /** Name of the queue the job belonged to. */
  queueName: string;
  /** Queue-system job id. */
  jobId: string;
  /** Job type — mirrors {@link queueName} for single-type queues. */
  jobType: string;
  /** Terminal status for a dead-lettered job. */
  status: 'dead_letter';
  /** Human-readable reason the job was dead-lettered. */
  errorMessage: string;
  /** ISO-8601 timestamp when the job reached the DLQ. */
  completedAt: string;
  /** Partition key extracted from the payload, if any. */
  scopeKey?: string;
}

/**
 * Structural duplicate of queue's `DlqAuditRecord<TPayload>`, deliberately
 * widened: `payload` is `unknown` rather than a generic `TPayload`, so every
 * concrete `DlqAuditRecord<TPayload>` is assignable to this — which is what
 * makes {@link DrizzleJobAuditStore.onDlqAudit} plug into `defineQueue` without
 * an import.
 */
export type JobAuditRecord =
  | (JobAuditRecordBase & {
      /** Payload passed the queue's schema. */
      validPayload: true;
      /** The schema-validated payload. */
      payload: unknown;
      /** Configured retry limit that was exhausted before dead-lettering. */
      attemptCount: number;
    })
  | (JobAuditRecordBase & {
      /** Payload failed the queue's schema. */
      validPayload: false;
      /** The raw, unvalidated payload as read from the DLQ job. */
      rawPayload: unknown;
      /** Schema-invalid payloads are dead-lettered on the first attempt. */
      attemptCount: number;
    });

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** A storage-layer failure (connection loss, constraint violation, bad SQL, …). */
export interface JobAuditStoreFailureError extends OctError {
  key: 'job_audit_store_failure';
}

export type JobAuditStoreError = JobAuditStoreFailureError;

/**
 * What a {@link DrizzleJobAuditStore.record} call did.
 *
 * - `recorded` — a row was inserted.
 * - `skipped_unscoped` — a scope column is configured with no fixed `value`,
 *   and the record carried no `scopeKey`, so there is nothing to stamp it with.
 *   See {@link JobAuditScope}.
 */
export type JobAuditWriteOutcome = 'recorded' | 'skipped_unscoped';

/**
 * The scope column this store stamps, if any.
 *
 * `column` is the **TypeScript property name** on the Drizzle table (e.g.
 * `'tenantId'`), not the SQL column name — mirrors `./crud`'s `CrudScope`.
 *
 * `value` is optional, and that is the meaningful difference from
 * `./scoped-key-store`: a key store serves one scope, but a queue definition is
 * process-global — dead-lettered jobs from *every* scope flow through the one
 * sink. So by default the value is read **per record** from `record.scopeKey`
 * (which `defineQueue` populates via its `resolveScopeKey` seam). Pass a fixed
 * `value` only when every row belongs to the same scope.
 */
export interface JobAuditScope {
  column: string;
  value?: string;
}

export interface DrizzleJobAuditStore {
  /**
   * Insert one audit row. Returns the {@link JobAuditWriteOutcome} so a caller
   * can tell a real write from a scope-skip, rather than inferring it.
   */
  record(record: JobAuditRecord): Promise<Result<JobAuditWriteOutcome, JobAuditStoreError>>;
  /**
   * Adapter for `defineQueue({ onDlqAudit })` — structurally a `DlqAuditSink`.
   *
   * The first parameter is queue's per-job `QueueScope`; this store resolves its
   * db at construction and ignores it. Typed `unknown` so any `QueueScope<T>` is
   * accepted.
   *
   * **Throws** on a storage failure, because the seam returns `void` and a
   * swallowed error is a silently lost audit trail. `defineQueue` catches it,
   * logs `Failed to run DLQ audit sink`, and keeps the batch alive. Use
   * {@link record} directly if you want the `Result` instead.
   */
  onDlqAudit(scope: unknown, record: JobAuditRecord): Promise<void>;
}

/**
 * Minimal structural view of a Drizzle Postgres db — satisfied by an augmented
 * `AppDatabase` AND by transaction contexts. Kept structural so instances from
 * different drizzle copies interoperate.
 */
export interface JobAuditStoreDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): { values(v: Record<string, unknown>): Promise<unknown> };
}

export interface CreateDrizzleJobAuditStoreDeps {
  db: JobAuditStoreDatabase;
  /** The job-audit Drizzle table (columns per {@link jobAuditColumns} + your scope column). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Scope column to stamp. Omit entirely in a single-scope deployment. */
  scope?: JobAuditScope;
}

/**
 * Build the Drizzle implementation of queue's `onDlqAudit` sink. Wire it into
 * `defineQueue`:
 *
 * ```ts
 * const auditStore = createDrizzleJobAuditStore({
 *   db,
 *   table: schema.jobAuditLog,
 *   scope: { column: 'tenantId' }, // value taken per-record from record.scopeKey
 * });
 *
 * export const emailQueue = defineQueue({
 *   name: 'email',
 *   schema: SCHEMA_EMAIL_PAYLOAD,
 *   createHandler,
 *   resolveScopeKey: (data) => data.tenantId, // populates record.scopeKey
 *   onDlqAudit: auditStore.onDlqAudit,
 * });
 * ```
 *
 * Scoping rules:
 * - No `scope` → no scope column is stamped; every record is written.
 * - `scope: { column }` → the column is stamped from `record.scopeKey`. Records
 *   without one (system/cron queues, which omit `resolveScopeKey`) cannot be
 *   stamped and are **skipped** with `skipped_unscoped` — the common case is an
 *   FK-bound, `NOT NULL` scope column that such a row could not satisfy anyway.
 *   Nothing is lost silently: `defineQueue` already logs every dead-letter with
 *   full context *before* invoking the sink, so those jobs are log-only.
 * - `scope: { column, value }` → the fixed value is stamped on every record and
 *   `record.scopeKey` is ignored.
 */
export function createDrizzleJobAuditStore(
  deps: CreateDrizzleJobAuditStoreDeps,
): DrizzleJobAuditStore {
  const { db, table, scope } = deps;

  async function record(
    auditRecord: JobAuditRecord,
  ): Promise<Result<JobAuditWriteOutcome, JobAuditStoreError>> {
    let scopeStamp: Record<string, string> = {};
    if (scope) {
      const scopeValue = scope.value ?? auditRecord.scopeKey;
      if (scopeValue == null) return ok('skipped_unscoped');
      scopeStamp = { [scope.column]: scopeValue };
    }

    try {
      await db.insert(table).values({
        ...scopeStamp,
        jobId: auditRecord.jobId,
        queueName: auditRecord.queueName,
        jobType: auditRecord.jobType,
        status: auditRecord.status,
        payload: auditRecord.validPayload ? auditRecord.payload : auditRecord.rawPayload,
        errorMessage: auditRecord.errorMessage,
        attemptCount: auditRecord.attemptCount,
        completedAt: auditRecord.completedAt,
      });
      return ok('recorded');
    } catch (error) {
      return err({
        key: 'job_audit_store_failure',
        message:
          `Failed to record job audit row for job ${auditRecord.jobId} on queue ` +
          `${auditRecord.queueName}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function onDlqAudit(_scope: unknown, auditRecord: JobAuditRecord): Promise<void> {
    const result = await record(auditRecord);
    if (!result.ok) throw new Error(result.error.message);
  }

  return { record, onDlqAudit };
}
