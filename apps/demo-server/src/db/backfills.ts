/**
 * One-shot data backfills — `@octabits-io/framework/drizzle/backfill`.
 *
 * The layer above SQL migrations: `ddl.ts` changes shapes, this moves data
 * into them. The demo has a genuine one — `notes.public_title` was added
 * (2026-08-31) to hold the customer-facing title, and every note that predates
 * it has an empty map. Seeding it from the internal title gives the operator
 * something to translate instead of a blank field.
 *
 * The protocol is what makes this safe to run on every boot:
 *   - the work selects only rows that still need it (`public_title = '{}'`),
 *     so a clean database is a no-op;
 *   - the marker in `data_migration_runs` is written only after a run with
 *     zero failures AND zero rows left, so a batched partial run retries on
 *     the next boot;
 *   - once marked, later boots pay a single primary-key lookup.
 */
import { count, sql } from 'drizzle-orm';
import { ensureDataMigrationRunsTable, runBackfills } from '@octabits-io/framework/drizzle/backfill';
import type { BackfillRunSummary } from '@octabits-io/framework/drizzle/backfill';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import type { Logger } from '@octabits-io/framework/logger';
import { notes, type Schema } from './schema.ts';

/** Rows still needing work — the same predicate the update and the count use. */
const NEEDS_PUBLIC_TITLE = sql`${notes.publicTitle} = '{}'::jsonb and ${notes.title} <> ''`;

/** Deliberately small, so the demo actually exercises the partial-run path. */
const BATCH_SIZE = 50;

export async function runDemoBackfills(
  db: AppDatabase<Schema>,
  logger: Logger,
): Promise<BackfillRunSummary[]> {
  // The marker table is this module's own, created on demand — no migration
  // file, no snapshot footprint (same category as `__drizzle_migrations`).
  await ensureDataMigrationRunsTable(db);

  return runBackfills(
    db,
    [
      {
        name: 'seed-note-public-title-from-title',
        run: async () => {
          const batch = await db
            .select({ id: notes.id, title: notes.title })
            .from(notes)
            .where(NEEDS_PUBLIC_TITLE)
            .limit(BATCH_SIZE);

          // One statement per row: the value is derived per row, and a demo
          // reads better than a jsonb_build_object CASE expression would.
          for (const row of batch) {
            await db.execute(
              sql`update ${notes} set public_title = ${JSON.stringify({ en: row.title })}::jsonb where id = ${row.id}`,
            );
          }

          const [remaining] = await db
            .select({ value: count() })
            .from(notes)
            .where(NEEDS_PUBLIC_TITLE);

          return {
            processed: batch.length,
            failures: 0,
            // > 0 leaves the backfill unmarked, so the next boot picks up the
            // next batch instead of declaring victory on a partial run.
            pending: remaining?.value ?? 0,
          };
        },
      },
    ],
    { logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) } },
  );
}
