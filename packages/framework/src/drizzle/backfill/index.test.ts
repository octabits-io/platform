import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ensureDataMigrationRunsTable,
  isDataMigrationCompleted,
  markDataMigrationCompleted,
  runBackfills,
  type BackfillDatabase,
  type BackfillLogger,
} from "./index.ts";

/** Render a captured Drizzle SQL condition to its Postgres text. */
const dialect = new PgDialect();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderSql = (where: unknown) => dialect.sqlToQuery(where as any).sql;

/**
 * Mock db capturing executed raw SQL, select-where SQL, and inserted values.
 * `markerRows` seeds what the completion-marker lookup returns, keyed by run
 * name via a resolver so multi-backfill chains can differ per name.
 */
function makeDb(markerRows: Array<Record<string, unknown>> = []) {
  const executed: string[] = [];
  const selectWheres: unknown[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const onConflictDoNothing = vi.fn(async () => undefined);
  const db: BackfillDatabase = {
    execute: async (q: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executed.push(dialect.sqlToQuery(q as any).sql);
      return undefined;
    },
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          selectWheres.push(w);
          return { limit: async () => markerRows };
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflictDoNothing };
      },
    }),
  };
  return { db, executed, selectWheres, inserted, onConflictDoNothing };
}

const silentLogger: BackfillLogger = { info: () => {}, warn: () => {} };

describe("marker helpers", () => {
  it("ensureDataMigrationRunsTable issues CREATE TABLE IF NOT EXISTS", async () => {
    const { db, executed } = makeDb();
    await ensureDataMigrationRunsTable(db);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("CREATE TABLE IF NOT EXISTS data_migration_runs");
  });

  it("isDataMigrationCompleted filters by name and returns null on miss", async () => {
    const { db, selectWheres } = makeDb([]);
    const result = await isDataMigrationCompleted(db, "backfill-x");
    expect(result).toBeNull();
    expect(renderSql(selectWheres[0])).toContain('"data_migration_runs"."name" =');
  });

  it("isDataMigrationCompleted returns the marker row on hit", async () => {
    const completedAt = new Date("2026-01-01T00:00:00Z");
    const { db } = makeDb([{ completedAt, notes: "processed=42" }]);
    const result = await isDataMigrationCompleted(db, "backfill-x");
    expect(result).toEqual({ completedAt, notes: "processed=42" });
  });

  it("markDataMigrationCompleted inserts with onConflictDoNothing (idempotent)", async () => {
    const { db, inserted, onConflictDoNothing } = makeDb();
    await markDataMigrationCompleted(db, "backfill-x", "processed=7");
    expect(inserted[0]).toMatchObject({ name: "backfill-x", notes: "processed=7" });
    expect(inserted[0]?.completedAt).toBeInstanceOf(Date);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("markDataMigrationCompleted stores null notes when omitted", async () => {
    const { db, inserted } = makeDb();
    await markDataMigrationCompleted(db, "backfill-x");
    expect(inserted[0]?.notes).toBeNull();
  });
});

describe("runBackfills", () => {
  it("ensures the marker table, runs a clean backfill, and marks it", async () => {
    const { db, executed, inserted } = makeDb([]);
    const run = vi.fn(async () => ({ processed: 3, failures: 0, pending: 0 }));

    const summaries = await runBackfills(db, [{ name: "backfill-a", run }], {
      logger: silentLogger,
    });

    expect(executed[0]).toContain("CREATE TABLE IF NOT EXISTS data_migration_runs");
    expect(run).toHaveBeenCalledTimes(1);
    expect(inserted[0]).toMatchObject({ name: "backfill-a", notes: "processed=3" });
    expect(summaries).toEqual([
      {
        name: "backfill-a",
        status: "completed",
        outcome: { processed: 3, failures: 0, pending: 0 },
      },
    ]);
  });

  it("fast-paths an already-marked backfill without invoking run()", async () => {
    const { db, inserted } = makeDb([
      { completedAt: new Date("2026-01-01T00:00:00Z"), notes: null },
    ]);
    const run = vi.fn(async () => ({ processed: 0, failures: 0, pending: 0 }));

    const summaries = await runBackfills(db, [{ name: "backfill-a", run }], {
      logger: silentLogger,
    });

    expect(run).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(summaries[0]).toEqual({ name: "backfill-a", status: "already_completed", outcome: null });
  });

  it("force re-runs a marked backfill but never re-marks it", async () => {
    const { db, inserted, onConflictDoNothing } = makeDb([
      { completedAt: new Date("2026-01-01T00:00:00Z"), notes: null },
    ]);
    const run = vi.fn(async () => ({ processed: 1, failures: 0, pending: 0 }));

    const summaries = await runBackfills(db, [{ name: "backfill-a", run }], {
      force: true,
      logger: silentLogger,
    });

    expect(run).toHaveBeenCalledTimes(1);
    // The marker insert still happens — onConflictDoNothing makes it a no-op
    // against the existing row, preserving the original timestamp/notes.
    expect(inserted).toHaveLength(1);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(summaries[0]?.status).toBe("completed");
  });

  it("does not mark when work is pending, so the next run retries", async () => {
    const { db, inserted } = makeDb([]);
    const summaries = await runBackfills(
      db,
      [{ name: "backfill-a", run: async () => ({ processed: 5, failures: 0, pending: 2 }) }],
      { logger: silentLogger },
    );

    expect(inserted).toHaveLength(0);
    expect(summaries[0]?.status).toBe("pending");
  });

  it("honors skipMarking on a clean run (partial-scope invocation)", async () => {
    const { db, inserted } = makeDb([]);
    const summaries = await runBackfills(
      db,
      [
        {
          name: "backfill-a",
          run: async () => ({ processed: 5, failures: 0, pending: 0, skipMarking: true }),
        },
      ],
      { logger: silentLogger },
    );

    expect(inserted).toHaveLength(0);
    expect(summaries[0]?.status).toBe("unmarked");
  });

  it("throws on failures, aborting the chain before later backfills", async () => {
    const { db, inserted } = makeDb([]);
    const second = vi.fn(async () => ({ processed: 0, failures: 0, pending: 0 }));

    await expect(
      runBackfills(
        db,
        [
          { name: "backfill-a", run: async () => ({ processed: 1, failures: 2, pending: 0 }) },
          { name: "backfill-b", run: second },
        ],
        { logger: silentLogger },
      ),
    ).rejects.toThrow("backfill-a: 2 failure(s)");

    expect(inserted).toHaveLength(0);
    expect(second).not.toHaveBeenCalled();
  });

  it("uses the outcome's notes for the marker when provided", async () => {
    const { db, inserted } = makeDb([]);
    await runBackfills(
      db,
      [
        {
          name: "backfill-a",
          run: async () => ({ processed: 1, failures: 0, pending: 0, notes: "custom" }),
        },
      ],
      { logger: silentLogger },
    );
    expect(inserted[0]?.notes).toBe("custom");
  });

  it("runs backfills in order and returns one summary per backfill", async () => {
    const order: string[] = [];
    const { db } = makeDb([]);
    const make = (name: string) => ({
      name,
      run: async () => {
        order.push(name);
        return { processed: 0, failures: 0, pending: 0 };
      },
    });

    const summaries = await runBackfills(db, [make("a"), make("b"), make("c")], {
      logger: silentLogger,
    });

    expect(order).toEqual(["a", "b", "c"]);
    expect(summaries.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });
});
