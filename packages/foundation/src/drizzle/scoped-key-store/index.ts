/**
 * @octabits-io/foundation/drizzle/scoped-key-store — the Drizzle adapter behind
 * `@octabits-io/foundation/pii`'s structural `ScopedKeyStore` seam.
 *
 * `@octabits-io/foundation/pii` owns the encryption logic but knows nothing about SQL,
 * drivers, or SQLSTATEs: it depends on a four-method `ScopedKeyStore`
 * (`insert` / `find` / `exists` / `destroy`), scope-bound at construction.
 * This module is the Postgres/Drizzle implementation of that seam — so pii
 * needs no `drizzle-orm` peer, and the ORM query logic lives in the package
 * that already owns Drizzle.
 *
 * The row/error types here are **structural duplicates** of pii's (same shape,
 * no import) — the same decoupling `@octabits-io/foundation/drizzle/config` uses
 * for its `ConfigCipher` seam. A `ScopedKeyStore` produced here plugs straight
 * into `createScopedKeyService({ store, ... })`.
 *
 * The store is bound to one `{ column, value }` scope at construction. The
 * scope column MUST be unique on the key table (one active key row per scope);
 * the lost-race → `scoped_key_store_conflict` signal relies on the resulting
 * SQLSTATE 23505. See `encryptionKeyColumns` in
 * `@octabits-io/foundation/drizzle/scope`.
 */
import { eq } from 'drizzle-orm';
import { type OctError, type Result, ok, err } from '../../result/index.ts';

/** New key row as pii hands it over — the scope column is stamped by the store. */
export interface NewScopedKeyRow {
  recipient: string;
  identityEncrypted: Buffer;
  blindIndexKeyEncrypted: Buffer;
}

/** A persisted key row, including the DB-assigned key version. */
export interface ScopedKeyRow extends NewScopedKeyRow {
  keyVersion: number;
}

/** A lost unique-constraint race — the row already exists (re-fetch to recover). */
export interface ScopedKeyStoreConflictError extends OctError {
  key: 'scoped_key_store_conflict';
}

/** Any other storage-layer failure (connection loss, bad SQL, …). */
export interface ScopedKeyStoreFailureError extends OctError {
  key: 'scoped_key_store_failure';
}

export type ScopedKeyStoreError = ScopedKeyStoreConflictError | ScopedKeyStoreFailureError;

/**
 * Structural, scope-bound key store — the seam pii consumes. pii sees no
 * SQL/drivers/SQLSTATEs; every method is already bound to one scope.
 */
export interface ScopedKeyStore {
  /** Insert the scope's key row; a lost unique race MUST err `scoped_key_store_conflict`. */
  insert(row: NewScopedKeyRow): Promise<Result<void, ScopedKeyStoreError>>;
  /** Fetch the scope's key row; `null` = expected absence (drives lazy generation). */
  find(): Promise<Result<ScopedKeyRow | null, ScopedKeyStoreError>>;
  /** Whether a key row exists for the scope. */
  exists(): Promise<Result<boolean, ScopedKeyStoreError>>;
  /** Delete the scope's key row (idempotent). */
  destroy(): Promise<Result<void, ScopedKeyStoreError>>;
}

/**
 * The `{ column, value }` pair a store instance is bound to. `column` is the
 * **TypeScript property name** on the Drizzle table (e.g. `'tenantId'`,
 * `'workspaceId'`), not the SQL column name — mirrors `./crud`'s `CrudScope`.
 */
export interface KeyStoreScope {
  column: string;
  value: string;
}

/**
 * Minimal structural view of a Drizzle Postgres db — satisfied by an augmented
 * `AppDatabase` AND by transaction contexts. Kept structural so instances from
 * different drizzle copies interoperate.
 */
export interface ScopedKeyStoreDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields: Record<string, any>): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: any): { where(w: unknown): { limit(n: number): Promise<any[]> } };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): { values(v: Record<string, unknown>): Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): { where(w: unknown): Promise<unknown> };
}

/** A `ScopedKeyStore` that can be re-bound to a transaction db via `withDb`. */
export interface DrizzleScopedKeyStore extends ScopedKeyStore {
  /**
   * Return a store issuing against `txDb` (same table + scope). Stateless
   * closure — cheap to build per transaction. Use inside `db.transaction` so
   * generation writes land in the caller's transaction.
   */
  withDb(txDb: ScopedKeyStoreDatabase): DrizzleScopedKeyStore;
}

export interface CreateDrizzleScopedKeyStoreDeps {
  db: ScopedKeyStoreDatabase;
  /** The encryption-key Drizzle table (columns per `./scope`'s `encryptionKeyColumns` + a scope column). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Scope this store is bound to (column property name + value). */
  scope: KeyStoreScope;
}

/**
 * Postgres unique-violation detection (SQLSTATE 23505), walking the `cause`
 * chain (bounded depth) so driver/ORM wrappers (e.g. `DrizzleQueryError`)
 * don't hide the code. Moved here from `@octabits-io/foundation/pii` — the SQLSTATE is an
 * SQL-layer concern that belongs on the Drizzle side of the seam.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 10; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function failure(message: string): ScopedKeyStoreFailureError {
  return { key: 'scoped_key_store_failure', message };
}

/**
 * Build the Drizzle implementation of pii's `ScopedKeyStore`, bound to one
 * `{ column, value }` scope. Wire it into `createScopedKeyService`:
 *
 * ```ts
 * const scope = { column: 'tenantId', value: tenantId };
 * const store = createDrizzleScopedKeyStore({ db, table: schema.encryptionKey, scope });
 * const keyService = createScopedKeyService({ store, scope, masterKeyProvider, cache });
 * // inside a transaction, re-bind the store so the write joins the tx:
 * await db.transaction(async (tx) => { await keyService.generateKeyPair(store.withDb(tx)); });
 * ```
 */
export function createDrizzleScopedKeyStore(deps: CreateDrizzleScopedKeyStoreDeps): DrizzleScopedKeyStore {
  const { db, table, scope } = deps;
  const scopePredicate = () => eq(table[scope.column], scope.value);
  const label = `${scope.column}=${scope.value}`;

  async function insert(row: NewScopedKeyRow): Promise<Result<void, ScopedKeyStoreError>> {
    try {
      await db.insert(table).values({ [scope.column]: scope.value, ...row });
      return ok(undefined);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return err({
          key: 'scoped_key_store_conflict',
          message: `Scoped key row for ${label} already exists`,
        });
      }
      return err(failure(
        `Failed to insert scoped key row for ${label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  async function find(): Promise<Result<ScopedKeyRow | null, ScopedKeyStoreError>> {
    try {
      const rows = await db
        .select({
          recipient: table.recipient,
          identityEncrypted: table.identityEncrypted,
          blindIndexKeyEncrypted: table.blindIndexKeyEncrypted,
          keyVersion: table.keyVersion,
        })
        .from(table)
        .where(scopePredicate())
        .limit(1);
      return ok((rows[0] as ScopedKeyRow | undefined) ?? null);
    } catch (error) {
      return err(failure(
        `Failed to load scoped key row for ${label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  async function exists(): Promise<Result<boolean, ScopedKeyStoreError>> {
    try {
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(scopePredicate())
        .limit(1);
      return ok(rows.length > 0);
    } catch (error) {
      return err(failure(
        `Failed to check scoped key row for ${label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  async function destroy(): Promise<Result<void, ScopedKeyStoreError>> {
    try {
      await db.delete(table).where(scopePredicate());
      return ok(undefined);
    } catch (error) {
      return err(failure(
        `Failed to destroy scoped key row for ${label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  function withDb(txDb: ScopedKeyStoreDatabase): DrizzleScopedKeyStore {
    return createDrizzleScopedKeyStore({ db: txDb, table, scope });
  }

  return { insert, find, exists, destroy, withDb };
}
