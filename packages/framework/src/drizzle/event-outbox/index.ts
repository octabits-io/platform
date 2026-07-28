/**
 * @octabits-io/framework/drizzle/event-outbox — the Drizzle/Postgres
 * implementation of `@octabits-io/framework/events`' `EventOutboxStore` seam:
 * a transactional outbox whose bigserial `id` is the envelope `seq`, plus the
 * NOTIFY send for both lanes.
 *
 * The atomicity mechanism lives here: {@link DrizzleEventOutboxStore.append}
 * runs the row INSERT **and** `pg_notify(...)` on the same connection/
 * transaction, and Postgres delivers NOTIFY at COMMIT — so the state change,
 * the outbox row, and the wakeup are one atomic unit. Methods **throw** on
 * failure (no `Result`): inside the caller's transaction, the throw is what
 * rolls the state change back with the failed event.
 *
 * The notification payload format is shared code — {@link encodeEventPointer}
 * / {@link encodeInlineEvent} from `../../events/codec.ts` — not a
 * structurally-duplicated convention: a wire *format* that drifts between
 * encoder and decoder fails silently. The codec file is dependency-free, so
 * this import pulls in nothing beyond the format itself.
 *
 * Build the table from {@link eventOutboxColumns} plus your own scope column:
 *
 * ```ts
 * import { pgTable, text, index } from 'drizzle-orm/pg-core';
 * import { eventOutboxColumns } from '@octabits-io/framework/drizzle/event-outbox';
 *
 * export const eventOutbox = pgTable(
 *   'event_outbox',
 *   {
 *     ...eventOutboxColumns,
 *     tenantId: text('tenant_id').notNull(), // your scope column
 *   },
 *   (t) => [index('event_outbox_scope_seq_idx').on(t.tenantId, t.id)],
 * );
 * ```
 *
 * RLS, constraints, and the prune schedule belong to the consumer.
 */
import { sql } from 'drizzle-orm';
import { bigserial, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { jsonbSafe } from '../scope/index.ts';
import {
  encodeEventPointer,
  encodeInlineEvent,
} from '../../events/codec.ts';
import type { EventEnvelope } from '../../events/types.ts';

// ---------------------------------------------------------------------------
// Column-set (extension mechanism)
// ---------------------------------------------------------------------------

/**
 * Generic outbox columns — one row per durable event. The **scope-reference
 * column is intentionally not part of the set**: declare it yourself so you
 * own its name, type, FK, and RLS policy. Add an index on
 * `(scopeColumn, id)` — every read is `scope = ? AND id > ?`.
 */
export const eventOutboxColumns = {
  /** The envelope `seq` — monotonic per outbox, assigned at insert. */
  id: bigserial({ mode: 'number' }).primaryKey().notNull(),
  /** The envelope `id` (globally unique dedupe key). */
  eventId: text('event_id').notNull(),
  /** Event type (consumer taxonomy, e.g. `order.created`). */
  type: text().notNull(),
  /** Emission time from the envelope (server clock, ISO). */
  at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  /**
   * Domain payload. `jsonbSafe` (not stock `jsonb()`): payloads are
   * `unknown`, and a top-level JSON string would be re-parsed and silently
   * retyped by stock `jsonb()` on read.
   */
  data: jsonbSafe(),
  /** The envelope `actor`, verbatim. */
  actor: jsonb(),
  /** The envelope `audience`, verbatim — re-evaluated per subscriber at delivery. */
  audience: jsonb(),
  /** The envelope `resources` keys, verbatim. */
  resources: jsonb(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * The scope column this store stamps and filters by. `column` is the
 * **TypeScript property name** on the Drizzle table (e.g. `'tenantId'`), not
 * the SQL column name — mirrors `./crud`'s `CrudScope`.
 *
 * `value` is optional: by default the store is process-global and stamps each
 * row from `envelope.scopeKey` (the publisher serves every scope). Pass a
 * fixed `value` only for a store bound to exactly one scope.
 */
export interface EventOutboxScope {
  column: string;
  value?: string;
}

/**
 * Minimal structural view of a Drizzle Postgres db — satisfied by a db
 * instance AND by transaction contexts. Kept structural so instances from
 * different drizzle copies interoperate.
 */
export interface EventOutboxDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): {
    values(v: Record<string, unknown>): { returning(fields: Record<string, unknown>): Promise<unknown> };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields: Record<string, any>): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: any): {
      where(w: unknown): {
        orderBy(o: unknown): { limit(n: number): Promise<Record<string, unknown>[]> };
      };
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): { where(w: unknown): { returning(fields: Record<string, unknown>): Promise<unknown> } };
  execute(query: unknown): Promise<unknown>;
}

export interface CreateDrizzleEventOutboxStoreDeps {
  db: EventOutboxDatabase;
  /** The outbox Drizzle table (columns per {@link eventOutboxColumns} + your scope column). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /**
   * Notification channel name — must match the listener's
   * (`createPgNotifyListener({ channel })`). Plain identifier only.
   */
  channel: string;
  /** Scope column to stamp/filter. Omit entirely in a single-scope deployment. */
  scope?: EventOutboxScope;
}

/** Structural match for `@octabits-io/framework/events`' `EventOutboxStore`. */
export interface DrizzleEventOutboxStore {
  append(envelope: EventEnvelope, tx?: unknown): Promise<{ seq: number }>;
  notify(envelope: EventEnvelope, tx?: unknown): Promise<void>;
  readSince(scopeKey: string, afterSeq: number, limit?: number): Promise<EventEnvelope[]>;
  prune(before: Date): Promise<number>;
}

const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createDrizzleEventOutboxStore(
  deps: CreateDrizzleEventOutboxStoreDeps,
): DrizzleEventOutboxStore {
  const { db, table, channel, scope } = deps;
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error(`Invalid notification channel name '${channel}' — must match ${CHANNEL_PATTERN}`);
  }

  function conn(tx?: unknown): EventOutboxDatabase {
    return (tx as EventOutboxDatabase | undefined) ?? db;
  }

  function scopeValue(envelope: EventEnvelope): string {
    return scope?.value ?? envelope.scopeKey;
  }

  async function append(envelope: EventEnvelope, tx?: unknown): Promise<{ seq: number }> {
    if (envelope.lane !== 'durable') {
      throw new Error(`append() is durable-lane only; got '${envelope.lane}' for event '${envelope.type}'`);
    }
    const target = conn(tx);
    const rows = (await target
      .insert(table)
      .values({
        ...(scope ? { [scope.column]: scopeValue(envelope) } : {}),
        eventId: envelope.id,
        type: envelope.type,
        at: envelope.at,
        data: envelope.data ?? null,
        actor: envelope.actor ?? null,
        audience: envelope.audience ?? null,
        resources: envelope.resources ?? null,
      })
      .returning({ id: table.id })) as Array<{ id: number }>;
    const seq = rows[0]?.id;
    if (seq === undefined) throw new Error('Outbox insert returned no id');
    // Same connection/transaction as the insert: pg delivers this at COMMIT,
    // never for a rolled-back row. This line is the atomicity guarantee.
    await target.execute(
      sql`select pg_notify(${channel}, ${encodeEventPointer(envelope.scopeKey, seq)})`,
    );
    return { seq };
  }

  async function notify(envelope: EventEnvelope, tx?: unknown): Promise<void> {
    if (envelope.lane !== 'ephemeral') {
      throw new Error(`notify() is ephemeral-lane only; got '${envelope.lane}' for event '${envelope.type}'`);
    }
    await conn(tx).execute(sql`select pg_notify(${channel}, ${encodeInlineEvent(envelope)})`);
  }

  function rowToEnvelope(row: Record<string, unknown>, scopeKey: string): EventEnvelope {
    return {
      id: row['eventId'] as string,
      seq: row['id'] as number,
      type: row['type'] as string,
      scopeKey,
      at: new Date(row['at'] as string).toISOString(),
      lane: 'durable',
      data: row['data'],
      actor: (row['actor'] as EventEnvelope['actor']) ?? undefined,
      audience: (row['audience'] as EventEnvelope['audience']) ?? undefined,
      resources: (row['resources'] as string[] | null) ?? undefined,
    };
  }

  async function readSince(scopeKey: string, afterSeq: number, limit = 200): Promise<EventEnvelope[]> {
    const seqFilter = sql`${table.id} > ${afterSeq}`;
    const where = scope
      ? sql`${table[scope.column]} = ${scope.value ?? scopeKey} and ${seqFilter}`
      : seqFilter;
    const rows = await db
      .select({
        id: table.id,
        eventId: table.eventId,
        type: table.type,
        at: table.at,
        data: table.data,
        actor: table.actor,
        audience: table.audience,
        resources: table.resources,
      })
      .from(table)
      .where(where)
      .orderBy(table.id)
      .limit(limit);
    return rows.map((row) => rowToEnvelope(row, scopeKey));
  }

  async function prune(before: Date): Promise<number> {
    const rows = (await db
      .delete(table)
      .where(sql`${table.createdAt} < ${before.toISOString()}`)
      .returning({ id: table.id })) as Array<{ id: number }>;
    return rows.length;
  }

  return { append, notify, readSince, prune };
}
