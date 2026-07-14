/**
 * Drizzle schema for the contact desk.
 *
 * Two of these tables are built from framework column-sets rather than
 * hand-written columns:
 *   - `settings`      ← `scopedConfigColumns` (`@octabits-io/framework/drizzle/scope`)
 *   - `idempotencyKey` ← `idempotencyKeyColumns` (`…/drizzle/idempotency`)
 *
 * Both column-sets deliberately omit the scope-reference column so the consumer
 * owns its name/type/constraints. This demo is single-scope, so we omit it
 * entirely and make `key` the whole primary key — exactly the "single-tenant
 * consumer" path both modules document.
 *
 * `contacts` and `notes` are plain tables: `baseScopeColumns` is NOT used for
 * them. Despite the tempting `id`/`name`/`createdAt` shape it is the *scope-owner
 * root* column-set (a workspace/tenant/organization row), not a generic
 * timestamp mixin — using it here would misrepresent what it is for.
 */
import { pgTable, primaryKey, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';
import { bytea, scopedConfigColumns } from '@octabits-io/framework/drizzle/scope';
import { idempotencyKeyColumns } from '@octabits-io/framework/drizzle/idempotency';
import { jobAuditColumns } from '@octabits-io/framework/drizzle/job-audit-store';

/**
 * A contact. `email` never lands in a readable column: the ciphertext lives in
 * `email_encrypted` (age / X25519 + ChaCha20-Poly1305) and `email_index` holds
 * an HMAC-SHA256 blind index so exact-match lookup stays possible without a
 * decryption key.
 *
 * Timestamps use Drizzle's default `mode: 'date'` (not `mode: 'string'`):
 * `createBaseCrudService` stamps `updatedAt` with a `Date` from its injected
 * `DateProvider`, so a string-mode column would fail on update.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    emailEncrypted: bytea('email_encrypted').notNull(),
    emailIndex: bytea('email_index').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('contacts_email_index_idx').on(t.emailIndex)],
);

/** A plain, non-PII table — the one `createBaseCrudService` drives end to end. */
export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Key/value settings store. Unscoped: `key` alone is the primary key. */
export const settings = pgTable(
  'settings',
  { ...scopedConfigColumns },
  (t) => [primaryKey({ columns: [t.key], name: 'settings_pk' })],
);

/** Idempotency records. Unscoped: `key` alone is the primary key. */
export const idempotencyKey = pgTable(
  'idempotency_key',
  { ...idempotencyKeyColumns },
  (t) => [
    primaryKey({ columns: [t.key], name: 'idempotency_key_pk' }),
    index('idempotency_key_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * Dead-lettered-job audit trail — `jobAuditColumns` from
 * `…/drizzle/job-audit-store`, unscoped (no scope column, single-scope demo).
 * Written by the welcome-email queue's `onDlqAudit` sink.
 */
export const jobAuditLog = pgTable('job_audit_log', { ...jobAuditColumns });

export const schema = { contacts, notes, settings, idempotencyKey, jobAuditLog };
export type Schema = typeof schema;
