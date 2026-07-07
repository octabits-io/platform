/**
 * @octabits-io/drizzle-toolkit/idempotency — a Stripe-style
 * `X-Idempotency-Key` store over any Drizzle Postgres table.
 *
 * `begin()` classifies an incoming request as one of three outcomes:
 *
 *   - `cached`   — a previous successful response for this key is replayed
 *   - `fresh`    — no (live) record yet; run the operation, then `commit()`
 *   - `conflict` — the same key was used with a *different* request signature
 *
 * Records carry a TTL (`expires_at`); expired rows are treated as fresh and
 * opportunistically swept on the next successful `commit()` for the same scope
 * (no cron needed). Only successful (2xx) responses should be committed —
 * errors are re-executed on retry, the simpler and more useful default.
 *
 * ## Seams
 *
 * Every external dependency is a *structural* interface so instances from a
 * different `drizzle-orm` copy (or a hand-rolled clock/logger) interoperate:
 *
 *   - {@link IdempotencyDatabase} — the `select`/`insert`/`delete` subset used
 *   - {@link DateProvider}        — clock injection (identical shape to
 *                                   `@octabits-io/foundation/utils`)
 *   - {@link IdempotencyLogger}   — optional structured logger (defaults to noop)
 *
 * ## Scoped vs unscoped
 *
 * A `scope` (`{ column, value }`) is **optional**. When provided, every query
 * is filtered by `eq(table[scope.column], scope.value)` and inserts stamp it —
 * giving per-scope isolation over a shared `(scopeColumn, key)` composite-PK
 * table. When omitted, the key alone is the primary key and no scope column is
 * referenced, which suits a single-tenant table.
 *
 * ## Table definition
 *
 * Spread {@link idempotencyKeyColumns} into your own `pgTable(...)` so the
 * column shapes stay in one place; add your own scope column (when scoping) and
 * declare the primary key, foreign key and expiry index in the table's
 * constraints callback (they depend on your concrete schema and desired
 * constraint names).
 */
import { and, eq, lt, type SQL } from "drizzle-orm";
import {
  jsonb,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { extractPgError } from "../db/index.ts";

// ---------------------------------------------------------------------------
// Column-set (extension mechanism)
// ---------------------------------------------------------------------------

/**
 * Generic `idempotency_key` columns — spread into a
 * `pgTable('idempotency_key', {...})` to define the store table.
 *
 * The **scope column is not part of the set** — add your own when scoping. The
 * primary key, any foreign key, and the `expires_at` index are all table-level
 * constraints declared in the table's constraints callback (they depend on your
 * concrete schema and on the constraint names you want to preserve):
 *
 * ```ts
 * import { pgTable, text, primaryKey, foreignKey, index } from 'drizzle-orm/pg-core';
 * import { idempotencyKeyColumns } from '@octabits-io/drizzle-toolkit/idempotency';
 *
 * // Scoped: add a scope column and put it first in the composite PK.
 * export const idempotencyKey = pgTable('idempotency_key', {
 *   ...idempotencyKeyColumns,
 *   tenantId: text('tenant_id').notNull(), // your scope column
 * }, (table) => [
 *   primaryKey({ columns: [table.tenantId, table.key], name: 'idempotency_key_pk' }),
 *   foreignKey({ columns: [table.tenantId], foreignColumns: [tenant.id], name: 'idempotency_key_tenant_id_fk' })
 *     .onUpdate('cascade').onDelete('cascade'),
 *   index('idempotency_key_expires_at_idx').on(table.expiresAt),
 * ]);
 * ```
 *
 * Single-tenant consumers omit the scope column entirely, make `(key)` the
 * primary key, and construct the service without a `scope`.
 */
export const idempotencyKeyColumns = {
  key: text().notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: smallint("response_status").notNull(),
  responseBody: jsonb("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
};

// ---------------------------------------------------------------------------
// Pure request helpers
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * SHA-256 hash of the request signature. Reuse across all callers so that the
 * same key on a different route or with a different body is treated as a
 * conflict (not a replay).
 */
export function hashRequest(method: string, pathTemplate: string, body: unknown): string {
  const payload = `${method}\n${pathTemplate}\n${JSON.stringify(body)}`;
  return createHash("sha256").update(payload).digest("hex");
}

/** Stripe-compatible: 1–255 printable ASCII. */
export function isValidIdempotencyKey(key: string): boolean {
  if (key.length < 1 || key.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]+$/.test(key);
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Clock-injection seam — structurally identical to
 * `@octabits-io/foundation/utils`' `DateProvider` (declared locally so this
 * subpath stays dependency-light and drizzle-copy agnostic).
 */
export interface DateProvider {
  now(): Date;
}

/**
 * Minimal structured-logger seam. Structurally compatible with
 * `@octabits-io/foundation/logger`'s `Logger` (a superset). Optional — a noop
 * is used when omitted.
 */
export interface IdempotencyLogger {
  warn(message: string, attributes?: Record<string, unknown>): void;
  debug(message: string, attributes?: Record<string, unknown>): void;
}

/**
 * Minimal structural view of an (augmented) Drizzle database — only the
 * `select`/`insert`/`delete` builders this service uses. Satisfied by any
 * `AppDatabase<TSchema>` from `./factory` and by transaction contexts. Kept
 * structural so instances from different drizzle copies interoperate.
 */
export interface IdempotencyDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): any;
}

// ---------------------------------------------------------------------------
// Public surface types
// ---------------------------------------------------------------------------

export type CachedResponse = { status: number; body: unknown };

/**
 * Persists the operation's final response under the in-progress idempotency
 * key so subsequent requests with the same key replay it. Call exactly once
 * per `fresh` outcome, only after the operation succeeded — failures should
 * NOT be cached (V1 behavior). Safe to await; concurrent races are handled
 * internally and never throw.
 */
export type IdempotencyCommit = (status: number, body: unknown) => Promise<void>;

export type IdempotencyOutcome =
  | { kind: "cached"; cached: CachedResponse }
  | { kind: "fresh"; commit: IdempotencyCommit }
  | { kind: "conflict" };

export interface IdempotencyService {
  begin(params: { key: string; requestHash: string }): Promise<IdempotencyOutcome>;
}

export interface CreateIdempotencyServiceParams {
  db: IdempotencyDatabase;
  /**
   * Table built from {@link idempotencyKeyColumns}. Typed loosely so tables
   * from a different `drizzle-orm` copy interoperate; the required columns
   * (`key`, `requestHash`, `responseStatus`, `responseBody`, `expiresAt`, and
   * the scope column when scoping) are accessed structurally.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  dateProvider: DateProvider;
  /**
   * Optional row scope (`{ column, value }`, mirroring `../crud`/`../config`).
   * When provided, every query is ANDed with `eq(table[scope.column],
   * scope.value)` and inserts stamp it; when omitted, the key alone identifies
   * the record (single-tenant tables). `column` is the **TypeScript property
   * name** on the Drizzle table (e.g. `'tenantId'`), not the SQL column name.
   */
  scope?: { column: string; value: string };
  /** Optional structured logger; a noop is used when omitted. */
  logger?: IdempotencyLogger;
  /** TTL for freshly committed records (default 24h). */
  ttlSeconds?: number;
}

const noopLogger: IdempotencyLogger = { warn: () => {}, debug: () => {} };

export function createIdempotencyService({
  db,
  table,
  dateProvider,
  scope,
  logger = noopLogger,
  ttlSeconds = DEFAULT_TTL_SECONDS,
}: CreateIdempotencyServiceParams): IdempotencyService {
  /**
   * ANDs the given conditions with the scope filter when a `scope` is set.
   * Returns a single condition unchanged so callers don't wrap a lone
   * predicate in `and(...)`.
   */
  function scopedWhere(...conditions: SQL[]): SQL {
    const all =
      scope !== undefined
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [eq((table as any)[scope.column], scope.value), ...conditions]
        : conditions;
    return (all.length === 1 ? all[0] : and(...all)) as SQL;
  }

  async function begin(params: { key: string; requestHash: string }): Promise<IdempotencyOutcome> {
    const { key, requestHash } = params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = table as any;

    const existing = await db
      .select({
        requestHash: t.requestHash,
        responseStatus: t.responseStatus,
        responseBody: t.responseBody,
        expiresAt: t.expiresAt,
      })
      .from(t)
      .where(scopedWhere(eq(t.key, key)))
      .limit(1);

    const row = existing[0];
    const now = dateProvider.now();

    if (row) {
      const expired = new Date(row.expiresAt) <= now;
      if (!expired && row.requestHash === requestHash) {
        return {
          kind: "cached",
          cached: { status: row.responseStatus, body: row.responseBody },
        };
      }
      if (!expired && row.requestHash !== requestHash) {
        return { kind: "conflict" };
      }
      // Expired — drop it and fall through to fresh.
      await db.delete(t).where(scopedWhere(eq(t.key, key)));
    }

    return {
      kind: "fresh",
      commit: async (status, body) => {
        const createdAt = now.toISOString();
        const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
        try {
          await db.insert(t).values({
            ...(scope !== undefined ? { [scope.column]: scope.value } : {}),
            key,
            requestHash,
            responseStatus: status,
            responseBody: body as object,
            createdAt,
            expiresAt,
          });
        } catch (err) {
          // Concurrent commit with same key won the race. Re-fetch and accept
          // the winner's response if hashes match; otherwise the operation
          // already produced a side effect we can't undo, so log and return —
          // the caller's response goes back to the client as-is, but no
          // further requests can replay it.
          if (isUniqueViolation(err)) {
            logger.warn("Idempotency commit lost race", { key, requestHash });
            return;
          }
          throw err;
        }

        // Opportunistic cleanup of expired rows for this scope. Bounded (by
        // the scope filter when scoped); cheap, no cron needed.
        try {
          await db.delete(t).where(scopedWhere(lt(t.expiresAt, now.toISOString())));
        } catch (err) {
          logger.debug("Idempotency expired-row cleanup failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    };
  }

  return { begin };
}

function isUniqueViolation(err: unknown): boolean {
  return extractPgError(err)?.code === "23505";
}
