/**
 * @octabits-io/framework/drizzle/backfill — the idempotent one-shot
 * data-backfill layer that sits *above* SQL migrations.
 *
 * SQL migrations change shapes; backfills move data into them. This module
 * ships the two halves of that layer:
 *
 *  1. **Marker helpers** over an append-only `data_migration_runs` table —
 *     the same category as Drizzle's own `__drizzle_migrations`: created on
 *     demand via `CREATE TABLE IF NOT EXISTS` ({@link ensureDataMigrationRunsTable}),
 *     no migration file, no snapshot footprint. Once a backfill is marked
 *     complete ({@link markDataMigrationCompleted}), re-invoking it on every
 *     deploy is a ~1ms primary-key lookup ({@link isDataMigrationCompleted}).
 *
 *  2. **{@link runBackfills}** — a chain runner owning the
 *     skip / mark / partial-retry protocol, for wiring a list of backfills
 *     after the SQL migration step of a deploy.
 *
 * ## The protocol
 *
 * Each backfill is a named, idempotent unit of work:
 *
 *   - Its work selects ONLY rows that still need processing (e.g.
 *     `WHERE new_col IS NULL AND legacy_col IS NOT NULL`) — re-running on a
 *     clean database must do nothing.
 *   - The completion marker is written only after a **fully clean run**: zero
 *     pending rows, zero failures, no partial-scope filter. A partial run is
 *     NOT marked — the next deploy retries automatically.
 *   - Failures abort the chain (throw) so the deploy fails loudly instead of
 *     silently marking bad state.
 *
 * ## Scope fan-out stays app-side
 *
 * The runner has no notion of scoping. When a backfill iterates scoped rows
 * (per org, per key, per anything), that loop lives inside the backfill's
 * `run()` — including any per-scope container/connection lifecycle — and its
 * result rolls the counts up across every scope. When the invocation was
 * filtered to a subset of scopes, return `skipMarking: true` so a
 * partial-scope run never claims global completion.
 *
 * ```ts
 * await runBackfills(db, [
 *   {
 *     name: 'backfill-invoice-totals-v2',
 *     run: async () => {
 *       let processed = 0;
 *       let failures = 0;
 *       // ... batch over rows still needing work, incrementing the counters ...
 *       const pending = await countRowsStillNeedingWork();
 *       return { processed, failures, pending };
 *     },
 *   },
 * ]);
 * ```
 *
 * The table intentionally has no scope column — backfills target legacy
 * shapes that disappear globally once retired; "done" is a global state. If a
 * deployment genuinely needs per-scope marking, encode the scope in the name.
 */
import { eq, sql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of an (augmented) Drizzle Postgres database — only
 * the builders this module uses. Satisfied by any `AppDatabase<TSchema>` from
 * `../factory`. Kept structural so instances from a different `drizzle-orm`
 * copy interoperate.
 */
export interface BackfillDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(query: any): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
}

/**
 * Progress-output seam. Defaults to `console` — the runner is deploy/CLI
 * tooling where a silent skip is worse than a stray log line. Pass a
 * structured logger (or noops) to redirect.
 */
export interface BackfillLogger {
  info(message: string): void;
  warn(message: string): void;
}

// ---------------------------------------------------------------------------
// Marker table + helpers
// ---------------------------------------------------------------------------

const dataMigrationRunsTable = pgTable("data_migration_runs", {
  name: text("name").primaryKey(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
});

export interface DataMigrationRun {
  completedAt: Date;
  notes: string | null;
}

/** Create the `data_migration_runs` marker table if it does not exist. Idempotent. */
export async function ensureDataMigrationRunsTable(db: BackfillDatabase): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS data_migration_runs (
      name text PRIMARY KEY,
      completed_at timestamptz NOT NULL DEFAULT now(),
      notes text
    )
  `);
}

/** Look up a backfill's completion marker. Returns `null` when never marked. */
export async function isDataMigrationCompleted(
  db: BackfillDatabase,
  name: string,
): Promise<DataMigrationRun | null> {
  const rows = await db
    .select({
      completedAt: dataMigrationRunsTable.completedAt,
      notes: dataMigrationRunsTable.notes,
    })
    .from(dataMigrationRunsTable)
    .where(eq(dataMigrationRunsTable.name, name))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Write a backfill's completion marker. Idempotent — a second mark for the
 * same name is a no-op (the first marker's timestamp and notes win).
 */
export async function markDataMigrationCompleted(
  db: BackfillDatabase,
  name: string,
  notes?: string,
): Promise<void> {
  await db
    .insert(dataMigrationRunsTable)
    .values({ name, notes: notes ?? null, completedAt: new Date() })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Chain runner
// ---------------------------------------------------------------------------

/** What a backfill's `run()` reports back to the runner. */
export interface BackfillOutcome {
  /** Rows (or units) actually transformed in this run. */
  processed: number;
  /** Units that errored. Any failure aborts the chain and prevents marking. */
  failures: number;
  /**
   * Units still needing work after this run (e.g. counted via the same
   * idempotency WHERE clause). When > 0 the marker is not written and the
   * next invocation retries.
   */
  pending: number;
  /**
   * Skip the completion marker even on a clean run — set when the invocation
   * covered only a subset of the data (e.g. a scope filter), so a partial run
   * never claims global completion.
   */
  skipMarking?: boolean;
  /** Free-text stored on the marker. Defaults to `processed=<n>`. */
  notes?: string;
}

/** A named one-shot backfill. */
export interface BackfillDef {
  /** Unique stable slug — the primary key in `data_migration_runs`. */
  name: string;
  /**
   * Perform the idempotent work. Invoked only when the backfill is not yet
   * marked complete (or `force` is set). Throw for hard failures — the chain
   * aborts and nothing is marked.
   */
  run(): Promise<BackfillOutcome>;
}

export interface RunBackfillsOptions {
  /** Re-run backfills even when already marked complete (never re-marks). */
  force?: boolean;
  /** Progress output; defaults to `console`. */
  logger?: BackfillLogger;
}

export interface BackfillRunSummary {
  name: string;
  /**
   * - `already_completed` — marker present, `run()` skipped (~1ms fast path)
   * - `completed`         — ran clean and the marker was written
   * - `pending`           — ran without failures but work remains; not marked,
   *                         the next invocation retries
   * - `unmarked`          — ran clean but `skipMarking` was set (partial scope)
   */
  status: "already_completed" | "completed" | "pending" | "unmarked";
  outcome: BackfillOutcome | null;
}

/**
 * Run a chain of one-shot backfills against `db`, owning the
 * skip / mark / partial-retry protocol (see the module doc). Call it after
 * SQL migrations in the deploy pipeline; once everything is marked, the whole
 * chain costs one primary-key lookup per backfill.
 *
 * Throws when a backfill reports `failures > 0` (or its `run()` throws) —
 * the remaining chain is not executed and nothing further is marked.
 */
export async function runBackfills(
  db: BackfillDatabase,
  backfills: readonly BackfillDef[],
  options: RunBackfillsOptions = {},
): Promise<BackfillRunSummary[]> {
  const { force = false, logger = console } = options;

  await ensureDataMigrationRunsTable(db);

  const summaries: BackfillRunSummary[] = [];

  for (const backfill of backfills) {
    if (!force) {
      const existing = await isDataMigrationCompleted(db, backfill.name);
      if (existing) {
        logger.info(
          `${backfill.name} already completed at ${existing.completedAt.toISOString()}${existing.notes ? ` (${existing.notes})` : ""}`,
        );
        summaries.push({ name: backfill.name, status: "already_completed", outcome: null });
        continue;
      }
    }

    logger.info(`→ ${backfill.name}`);
    const outcome = await backfill.run();
    logger.info(
      `${backfill.name}: processed=${outcome.processed}, failures=${outcome.failures}, pending=${outcome.pending}`,
    );

    if (outcome.failures > 0) {
      throw new Error(
        `${backfill.name}: ${outcome.failures} failure(s) — completion marker not written; see logs above`,
      );
    }

    if (outcome.skipMarking) {
      logger.info(`${backfill.name}: skipping completion marker (skipMarking set)`);
      summaries.push({ name: backfill.name, status: "unmarked", outcome });
      continue;
    }

    if (outcome.pending > 0) {
      logger.warn(
        `${backfill.name}: skipping completion marker (pending=${outcome.pending}) — will retry on the next run`,
      );
      summaries.push({ name: backfill.name, status: "pending", outcome });
      continue;
    }

    await markDataMigrationCompleted(
      db,
      backfill.name,
      outcome.notes ?? `processed=${outcome.processed}`,
    );
    summaries.push({ name: backfill.name, status: "completed", outcome });
  }

  return summaries;
}
