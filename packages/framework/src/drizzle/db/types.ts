/**
 * Shared structural seams for the drizzle modules.
 *
 * Every `drizzle/*` module declares the smallest database surface it needs
 * (its `*Database` interface) instead of importing drizzle-orm's nominal
 * types — instances from different `drizzle-orm` copies must interoperate,
 * and narrow seams keep test fakes one-liners. {@link DbOrTx} plus the
 * `Db*` capability atoms below are the vocabulary those seams compose;
 * a new module's seam should be a composition, never a hand-rolled shape:
 *
 * ```ts
 * export interface MyModuleDatabase extends DbOrTx, DbInsertTarget {}
 * ```
 *
 * The atoms are `any`-typed on purpose: they are *presence* markers ("this
 * module calls `select`"), not typed contracts. Row/result typing never
 * flows through the seams — on the consumer side it lives in the factories'
 * generics (`TTable extends PgTable`, `$inferSelect`); on the framework side
 * an adapter casts once to the `DrizzleView` alias in `./internal.ts` so its
 * builder chains typecheck against drizzle's real declarations.
 */

/**
 * Minimal structural view of anything that can run one SQL statement — a
 * Drizzle Postgres **db instance OR a transaction context** (both expose
 * `execute`). Use it directly for modules that only need to run SQL
 * (e.g. `drizzle/broadcast`), or extend it for richer module seams.
 *
 * Deliberately structural: never replace this with drizzle-orm's
 * `PgDatabase`/`PgTransaction` — nominal types break the moment two
 * drizzle-orm copies exist in a dependency tree.
 */
export interface DbOrTx {
  execute(query: unknown): Promise<unknown>;
}

/** Has Drizzle's `select` builder entry point. */
export interface DbSelectSource {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields: any): any;
}

/** Has Drizzle's `insert` builder entry point. */
export interface DbInsertTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
}

/** Has Drizzle's `update` builder entry point. */
export interface DbUpdateTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table: any): any;
}

/** Has Drizzle's `delete` builder entry point. */
export interface DbDeleteTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): any;
}

/** Has Drizzle's relational-query namespace (`db.query.table.findMany(...)`). */
export interface DbRelationalQuery {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: Record<string, any>;
}

/** Can run a Drizzle-managed transaction (savepoint-correct when nested). */
export interface DbTransactionRunner {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}
