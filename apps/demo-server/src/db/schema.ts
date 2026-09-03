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
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { LocaleMap } from '@octabits-io/framework/utils';
import type { ProposalDecision, ResolvedOperation } from '@octabits-io/framework/proposal';
import { bytea, scopedConfigColumns } from '@octabits-io/framework/drizzle/scope';
import { eventOutboxColumns } from '@octabits-io/framework/drizzle/event-outbox';
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
    // The travel wish this contact is shopping for: a window they could travel
    // in (earliest arrival → latest departure) plus the stay length they want
    // inside it. Nullable as a set — a contact without a wish is the norm.
    // `mode: 'string'` keeps these as the ISO `YYYY-MM-DD` the kit's `Period`
    // speaks, so no date object ever enters the transport.
    wishStart: date('wish_start', { mode: 'string' }),
    wishEnd: date('wish_end', { mode: 'string' }),
    wishNights: integer('wish_nights'),
    // The AI-written one-line brief — the slot the contact-brief workflow
    // proposes an update to. Nullable: most contacts have none, and "empty"
    // is exactly what the proposal's `current` must be able to say.
    brief: text('brief'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('contacts_email_index_idx').on(t.emailIndex)],
);

/**
 * A plain, non-PII table — the one `createBaseCrudService` drives end to end.
 *
 * `title`/`body` are the internal note. `publicTitle`/`publicBody` are the
 * customer-facing version of it, per content locale — a `LocaleMap<string>`
 * stored as jsonb, which is the shape the kit's `LocaleInput`/`LocaleTextarea`
 * edit and `resolveLocale` reads. Defaulting to `{}` (rather than allowing
 * NULL) keeps every read a map: a note with no translations differs from one
 * with an empty English string, and neither is null.
 */
export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  publicTitle: jsonb('public_title').$type<LocaleMap<string>>().notNull().default({}),
  publicBody: jsonb('public_body').$type<LocaleMap<string>>().notNull().default({}),
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

/**
 * Transactional event outbox — `eventOutboxColumns` from
 * `…/drizzle/event-outbox`, unscoped (no scope column, single-scope demo).
 * The bigserial `id` is the envelope `seq`; rows are written by
 * `eventPublisher.emit(…, tx)` in the same transaction as the state change.
 */
export const eventOutbox = pgTable('event_outbox', { ...eventOutboxColumns });

/**
 * One row per applied AI proposal — the audit half of the review loop
 * (`@octabits-io/framework/proposal`; see `ai/proposals.ts`). Keyed by the
 * workflow that produced the proposal. `applied` holds the resolved
 * operations exactly as written (edits folded in, `current` intact) and
 * `created` the ids this host assigned to creates — together they are what
 * `invertOperations` needs to revert, so a revert never re-reads the entity.
 * `applied_at`/`reverted_at` are what the workflow wire view projects as
 * `appliedAt`.
 */
export const proposalApplications = pgTable('proposal_applications', {
  workflowId: bigint('workflow_id', { mode: 'number' }).primaryKey(),
  scope: text('scope').notNull(),
  decision: jsonb('decision').$type<ProposalDecision>().notNull(),
  applied: jsonb('applied').$type<ResolvedOperation[]>().notNull(),
  created: jsonb('created').$type<Record<string, string>>().notNull().default({}),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
  appliedBy: text('applied_by'),
  revertedAt: timestamp('reverted_at', { withTimezone: true }),
});

export const schema = {
  contacts,
  notes,
  settings,
  idempotencyKey,
  jobAuditLog,
  eventOutbox,
  proposalApplications,
};
export type Schema = typeof schema;
