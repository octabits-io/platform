/**
 * Notes service — `createBaseCrudService` (`…/drizzle/crud`) driving a whole
 * entity with no hand-written query code.
 *
 * The factory needs three things beyond the table itself:
 *   - `tableName` must match a key in `db.query.*`, so the table has to be part
 *     of the schema object handed to `createDrizzle`.
 *   - `resourceName` drives the not-found error key (`note_not_found` → 404 via
 *     the framework's key conventions — no status mapping needed).
 *   - `dateProvider` stamps `updatedAt` on update.
 *
 * `createScopedCrudService` is its partitioned sibling (every query ANDed with a
 * scope column). This demo is single-scope, so the base factory is the right one.
 */
import { desc } from 'drizzle-orm';
import { createBaseCrudService } from '@octabits-io/framework/drizzle/crud';
import type { DateProvider, LocaleMap } from '@octabits-io/framework/utils';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import { notes, type Schema } from '../db/schema.ts';

export interface Note {
  id: string;
  title: string;
  body: string;
  /**
   * The customer-facing version of the note, one entry per content locale.
   * Kept as a map all the way to the browser — the kit's locale-field editors
   * bind a `LocaleMap<string>` directly, so resolving it server-side would
   * throw away exactly the shape the editor needs.
   */
  publicTitle: LocaleMap<string>;
  publicBody: LocaleMap<string>;
  createdAt: string;
  updatedAt: string;
}

export interface NotesServiceDeps {
  db: AppDatabase<Schema>;
  dateProvider: DateProvider;
}

export function createNotesService({ db, dateProvider }: NotesServiceDeps) {
  return createBaseCrudService<typeof notes, Note>({
    db,
    dateProvider,
    table: notes,
    tableName: 'notes',
    resourceName: 'note',
    mapToEntity: (row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      publicTitle: row.publicTitle,
      publicBody: row.publicBody,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
    listWhereConditions: () => [],
  });
}

export type NotesService = ReturnType<typeof createNotesService>;

/** Newest-first ordering for the list route (the factory sorts by nothing). */
export const NOTES_DEFAULT_ORDER = desc(notes.createdAt);
