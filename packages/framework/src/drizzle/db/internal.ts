/**
 * Adapter-internal typed view of a seam-satisfying database — deliberately
 * **not** re-exported from `../db`'s public surface, so nothing drizzle-shaped
 * reaches the emitted declarations of the `*Database` seams.
 *
 * The drizzle adapters accept the structural `Db*` atoms publicly (copy-
 * interop, one-liner fakes, insulation from drizzle's type churn) and cast
 * **once** to this alias inside the implementation, so their builder chains
 * typecheck against drizzle-orm's real declarations — which catches drizzle
 * builder-API changes at framework typecheck time, where a hand-typed chain
 * seam would drift silently.
 *
 * The cast asserts exactly the contract the seams document: anything
 * satisfying a `*Database` seam behaves like a Drizzle Postgres db (or
 * transaction context) for the calls the module makes. Integration tests
 * against real Postgres are the runtime backstop.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

export type DrizzleView = PgDatabase<PgQueryResultHKT>;
