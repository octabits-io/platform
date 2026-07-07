/**
 * Per-scope Age keypair + blind-index HMAC key management: lazy
 * auto-generation, cached decryption, `getKeys` / `hasKeys` / `destroyKeys` /
 * cache invalidation. Keys are stored encrypted with the master key and
 * cached in memory after decryption.
 *
 * Generic over the scope column: one service instance is bound to one
 * `{ column, value }` scope — the consumer chooses the column (e.g.
 * `{ column: 'tenantId', value: tenantId }`, or `workspaceId`, `ownerId`, …).
 * Generic over the storage table too: pass an encryption-key Drizzle table
 * (e.g. `@octabits-io/drizzle-toolkit/scope`'s `encryptionKeyColumns` plus a
 * consumer-declared scope column, or an app schema with the same columns)
 * plus its `db.query` key. The cache is injected (any
 * `{ get/set/has/delete/clear }` — e.g. a foundation LruCacheService cache
 * with a 5-minute TTL).
 */
import crypto from 'node:crypto';
import { type OctError, type Result, ok, err, tryCatchAsync } from '@octabits-io/foundation/result';
import type { MasterKeyProvider, MasterKeyProviderError } from './master-key.ts';
import { generateIdentity, identityToRecipient } from './typage/index.ts';

// drizzle-orm is an OPTIONAL peer dependency. Invariant: it must never be
// imported at module top level — this file is re-exported from the root
// barrel, so a static import would make `import '@octabits-io/pii'` crash for
// consumers that don't install drizzle-orm. It is lazy-loaded (and cached) on
// the first call into a createScopedKeyService function instead; only those
// calls require drizzle-orm to be installed.
let drizzleOrm: Promise<typeof import('drizzle-orm')> | undefined;
function loadDrizzleOrm(): Promise<typeof import('drizzle-orm')> {
  drizzleOrm ??= import('drizzle-orm');
  return drizzleOrm;
}

/** The `{ column, value }` pair a key-service instance is bound to. */
export interface KeyScope {
  /**
   * TS property name of the scope column on the Drizzle table (e.g.
   * `'tenantId'`, `'workspaceId'`), not the SQL column name.
   */
  column: string;
  /** Scope value (e.g. the tenant id). */
  value: string;
}

export interface ScopedKeyNotFoundError extends OctError {
  key: 'scoped_keys_not_found';
  scope: KeyScope;
}

export interface ScopedKeyGenerationError extends OctError {
  key: 'scoped_key_generation_error';
  message: string;
  /**
   * True when generation lost a concurrent unique-constraint race — the row
   * already exists, so re-fetching the keys is the correct recovery.
   */
  conflict?: boolean;
}

/** A key-table read/write failed at the storage layer (connection loss, bad SQL, …). */
export interface ScopedKeyStorageError extends OctError {
  key: 'scoped_key_storage_error';
  message: string;
}

/**
 * Postgres unique-violation detection (SQLSTATE 23505), walking the `cause`
 * chain so driver/ORM wrappers (e.g. DrizzleQueryError) don't hide the code.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 10; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export type ScopedKeyError =
  | ScopedKeyNotFoundError
  | ScopedKeyGenerationError
  | ScopedKeyStorageError
  | MasterKeyProviderError;

/** Decrypted scope keys ready for use in encryption operations. */
export interface ScopedKeys {
  /** Age public key (age1...) for encryption */
  recipient: string;
  /** Age private key (AGE-SECRET-KEY-1...) for decryption */
  identity: string;
  /** HMAC key for blind index generation */
  blindIndexKey: string;
  /** Key version for rotation tracking */
  keyVersion: number;
}

/** Structural cache seam — satisfied by foundation's `LruCache`. */
export interface ScopedKeyCache {
  get(key: string): ScopedKeys | undefined;
  set(key: string, value: ScopedKeys): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
}

/** Structural row shape of the encryption-key table. */
interface ScopedKeyRow {
  recipient: string;
  identityEncrypted: Buffer;
  blindIndexKeyEncrypted: Buffer;
  keyVersion: number;
}

/** Minimal structural db view (insert/delete + relational query namespace). */
export interface ScopedKeyDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): { values(v: Record<string, unknown>): Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): { where(w: unknown): Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: Record<string, any>;
}

export interface ScopedKeyServiceDeps {
  db: ScopedKeyDb;
  /** Scope this instance is bound to (column property name + value). */
  scope: KeyScope;
  masterKeyProvider: MasterKeyProvider;
  /** The encryption-key Drizzle table (columns per drizzle-toolkit/scope's `encryptionKeyColumns` + a scope column). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Key of the table in `db.query` (e.g. 'encryptionKey'). */
  tableName: string;
  /**
   * Decrypted-key cache (recommend LRU with ~5-minute TTL).
   *
   * Cache entries are keyed by `encodeURIComponent(column):encodeURIComponent(value)`,
   * NOT by the table. WARNING: do not share one cache instance across services
   * that store keys in DIFFERENT tables under the same scope column+value —
   * their entries would collide. Use one cache per key table.
   */
  cache: ScopedKeyCache;
}

/**
 * Service for managing per-scope encryption keys: generation, cached
 * retrieval + decryption, destruction (offboarding), cache invalidation.
 */
export function createScopedKeyService({ db, scope, masterKeyProvider, table, tableName, cache }: ScopedKeyServiceDeps) {
  const keyCache = cache;
  // Qualified cache key: scope value alone would collide across services bound
  // to different scope columns (e.g. workspaceId 'x' vs tenantId 'x').
  const cacheKey = `${encodeURIComponent(scope.column)}:${encodeURIComponent(scope.value)}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scopeColumn = () => (table as any)[scope.column];

  async function findRow(): Promise<ScopedKeyRow | undefined> {
    const { eq } = await loadDrizzleOrm();
    return db.query[tableName]!.findFirst({
      where: eq(scopeColumn(), scope.value),
    });
  }

  /**
   * Generate a new encryption key pair for the scope. Call at scope creation
   * (or rely on `getKeys`' lazy generation). Secrets are encrypted with the
   * master key before storage.
   *
   * @param tx - Optional transaction context (same structural shape as db).
   *   When a transaction is passed, the decrypted-key cache is NOT
   *   pre-populated — the caller's transaction may still roll back, and a
   *   cached never-persisted key would make future encryptions unrecoverable.
   *   The cache is populated on the next `getKeys()` read instead.
   */
  async function generateKeyPair(
    tx?: ScopedKeyDb,
  ): Promise<Result<void, ScopedKeyError>> {
    try {
      // Generate new age key pair
      const identity = await generateIdentity();
      const recipient = await identityToRecipient(identity);

      // Generate blind index HMAC key (32 bytes = 256 bits)
      const blindIndexKey = crypto.randomBytes(32).toString('hex');

      // Encrypt secrets with master key
      const identityResult = await masterKeyProvider.encrypt(Buffer.from(identity));
      if (!identityResult.ok) return identityResult;

      const blindKeyResult = await masterKeyProvider.encrypt(Buffer.from(blindIndexKey));
      if (!blindKeyResult.ok) return blindKeyResult;

      // Store in database
      const conn = tx ?? db;
      await conn.insert(table).values({
        [scope.column]: scope.value,
        recipient,
        identityEncrypted: identityResult.value,
        blindIndexKeyEncrypted: blindKeyResult.value,
      });

      // Pre-populate the cache only when the insert went through the
      // service's own (auto-committing) db handle — never inside a caller
      // transaction that may still roll back. Read the row back so the cached
      // keyVersion is the actually-persisted one (DB default/trigger), not a
      // hardcoded guess. If the read-back fails, skip caching — the next
      // getKeys() populates it.
      if (!tx) {
        const rowResult = await tryCatchAsync(() => findRow());
        if (rowResult.ok && rowResult.value) {
          keyCache.set(cacheKey, { recipient, identity, blindIndexKey, keyVersion: rowResult.value.keyVersion });
        }
      }

      return ok(undefined);
    } catch (error) {
      return err({
        key: 'scoped_key_generation_error',
        message: `Failed to generate keys for ${scope.column}=${scope.value}: ${error instanceof Error ? error.message : String(error)}`,
        conflict: isUniqueViolation(error),
      });
    }
  }

  async function getKeysInner(depth: number): Promise<Result<ScopedKeys, ScopedKeyError>> {
    const cached = keyCache.get(cacheKey);
    if (cached) return ok(cached);

    const rowResult = await tryCatchAsync(() => findRow());
    if (!rowResult.ok) {
      return err({
        key: 'scoped_key_storage_error',
        message: `Failed to load keys for ${scope.column}=${scope.value}: ${rowResult.error.message}`,
      });
    }
    const row = rowResult.value;

    if (!row) {
      // Bound the generate→refetch recursion: one retry is enough to recover
      // from a lost unique-constraint race; anything beyond that is a broken
      // store and must not recurse indefinitely.
      if (depth >= 1) {
        return err({
          key: 'scoped_key_generation_error',
          message: `Keys for ${scope.column}=${scope.value} were generated but could not be re-fetched (retry exhausted)`,
        });
      }
      // Auto-generate keys for this scope (lazy initialization)
      const genResult = await generateKeyPair();
      if (!genResult.ok) {
        // Unique-constraint violation = concurrent generation → retry fetch
        if (genResult.error.key === 'scoped_key_generation_error' && genResult.error.conflict) {
          return getKeysInner(depth + 1);
        }
        return genResult;
      }
      // Keys are persisted (and usually cached) now — re-fetch once.
      return getKeysInner(depth + 1);
    }

    // Decrypt with master key
    const identityResult = await masterKeyProvider.decrypt(row.identityEncrypted);
    if (!identityResult.ok) return identityResult;

    const blindKeyResult = await masterKeyProvider.decrypt(row.blindIndexKeyEncrypted);
    if (!blindKeyResult.ok) return blindKeyResult;

    const keys: ScopedKeys = {
      recipient: row.recipient,
      identity: identityResult.value.toString('utf8'),
      blindIndexKey: blindKeyResult.value.toString('utf8'),
      keyVersion: row.keyVersion,
    };

    keyCache.set(cacheKey, keys);
    return ok(keys);
  }

  /**
   * Get decrypted encryption keys for the scope (cached after first
   * retrieval; lazily auto-generates on first use, retrying the fetch once
   * when a concurrent request won the unique-constraint race).
   */
  async function getKeys(): Promise<Result<ScopedKeys, ScopedKeyError>> {
    return getKeysInner(0);
  }

  /** Check if the scope has encryption keys. */
  async function hasKeys(): Promise<Result<boolean, ScopedKeyError>> {
    if (keyCache.has(cacheKey)) return ok(true);
    const rowResult = await tryCatchAsync(async () => {
      const { eq } = await loadDrizzleOrm();
      return db.query[tableName]!.findFirst({
        columns: { id: true },
        where: eq(scopeColumn(), scope.value),
      });
    });
    if (!rowResult.ok) {
      return err({
        key: 'scoped_key_storage_error',
        message: `Failed to check keys for ${scope.column}=${scope.value}: ${rowResult.error.message}`,
      });
    }
    return ok(rowResult.value !== undefined);
  }

  /**
   * Destroy encryption keys for the scope.
   *
   * WARNING: makes all encrypted data for this scope unrecoverable. Only for
   * offboarding when data should be permanently deleted.
   */
  async function destroyKeys(): Promise<Result<void, ScopedKeyError>> {
    keyCache.delete(cacheKey);
    const deleteResult = await tryCatchAsync(async () => {
      const { eq } = await loadDrizzleOrm();
      await db.delete(table).where(eq(scopeColumn(), scope.value));
    });
    if (!deleteResult.ok) {
      return err({
        key: 'scoped_key_storage_error',
        message: `Failed to destroy keys for ${scope.column}=${scope.value}: ${deleteResult.error.message}`,
      });
    }
    return ok(undefined);
  }

  /** Invalidate cached keys (use after key rotation). */
  function invalidateCache(): void {
    keyCache.delete(cacheKey);
  }

  /** Clear the entire key cache (forces re-decryption for all scopes). */
  function clearCache(): void {
    keyCache.clear();
  }

  return {
    generateKeyPair,
    getKeys,
    hasKeys,
    destroyKeys,
    invalidateCache,
    clearCache,
  };
}

export type ScopedKeyService = ReturnType<typeof createScopedKeyService>;
