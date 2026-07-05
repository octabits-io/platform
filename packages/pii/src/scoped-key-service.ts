/**
 * Per-scope Age keypair + blind-index HMAC key management: lazy
 * auto-generation, cached decryption, `getKeys` / `hasKeys` / `destroyKeys` /
 * cache invalidation. Keys are stored encrypted with the master key and
 * cached in memory after decryption.
 *
 * Generic over the scope column: one service instance is bound to one
 * `{ column, value }` scope (e.g. `{ column: 'tenantId', value: tenantId }` —
 * see `createTenantKeyService` for that preset — or `workspaceId`, `ownerId`,
 * …). Generic over the storage table too: pass an encryption-key Drizzle
 * table (e.g. `@octabits-io/drizzle-toolkit/tenant`'s `tenantEncryptionKey`
 * or an app schema with the same columns) plus its `db.query` key. The cache
 * is injected (any `{ get/set/has/delete/clear }` — e.g. a foundation
 * LruCacheService cache with a 5-minute TTL).
 */
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { type OctError, type Result, ok, err } from '@octabits-io/foundation/result';
import type { MasterKeyProvider, MasterKeyError } from './master-key.ts';
import { generateIdentity, identityToRecipient } from './typage/index.ts';

/** The `{ column, value }` pair a key-service instance is bound to. */
export interface KeyScope {
  /**
   * TS property name of the scope column on the Drizzle table (e.g.
   * `'tenantId'`, `'workspaceId'`), not the SQL column name.
   */
  column: string;
  /** Scope value (e.g. the tenant id). Also used as the cache key. */
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

export type ScopedKeyError = ScopedKeyNotFoundError | ScopedKeyGenerationError | MasterKeyError;

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
  /** The encryption-key Drizzle table (columns per drizzle-toolkit/tenant). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Key of the table in `db.query` (e.g. 'tenantEncryptionKey'). */
  tableName: string;
  /** Decrypted-key cache (recommend LRU with ~5-minute TTL). */
  cache: ScopedKeyCache;
}

/**
 * Service for managing per-scope encryption keys: generation, cached
 * retrieval + decryption, destruction (offboarding), cache invalidation.
 */
export function createScopedKeyService({ db, scope, masterKeyProvider, table, tableName, cache }: ScopedKeyServiceDeps) {
  const keyCache = cache;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scopeColumn = () => (table as any)[scope.column];

  /**
   * Generate a new encryption key pair for the scope. Call at scope creation
   * (or rely on `getKeys`' lazy generation). Secrets are encrypted with the
   * master key before storage.
   *
   * @param tx - Optional transaction context (same structural shape as db)
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

      // Pre-populate cache
      keyCache.set(scope.value, { recipient, identity, blindIndexKey, keyVersion: 1 });

      return ok(undefined);
    } catch (error) {
      return err({
        key: 'scoped_key_generation_error',
        message: `Failed to generate keys for ${scope.column}=${scope.value}: ${error instanceof Error ? error.message : String(error)}`,
        conflict: isUniqueViolation(error),
      });
    }
  }

  /**
   * Get decrypted encryption keys for the scope (cached after first
   * retrieval; lazily auto-generates on first use, retrying the fetch when a
   * concurrent request won the unique-constraint race).
   */
  async function getKeys(): Promise<Result<ScopedKeys, ScopedKeyError>> {
    const cached = keyCache.get(scope.value);
    if (cached) return ok(cached);

    const row: ScopedKeyRow | undefined = await db.query[tableName]!.findFirst({
      where: eq(scopeColumn(), scope.value),
    });

    if (!row) {
      // Auto-generate keys for this scope (lazy initialization)
      const genResult = await generateKeyPair();
      if (!genResult.ok) {
        // Unique-constraint violation = concurrent generation → retry fetch
        if (genResult.error.key === 'scoped_key_generation_error' && genResult.error.conflict) {
          return getKeys();
        }
        return genResult;
      }
      // Keys are now cached by generateKeyPair, return from cache
      return getKeys();
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

    keyCache.set(scope.value, keys);
    return ok(keys);
  }

  /** Check if the scope has encryption keys. */
  async function hasKeys(): Promise<boolean> {
    if (keyCache.has(scope.value)) return true;
    const row = await db.query[tableName]!.findFirst({
      columns: { id: true },
      where: eq(scopeColumn(), scope.value),
    });
    return row !== undefined;
  }

  /**
   * Destroy encryption keys for the scope.
   *
   * WARNING: makes all encrypted data for this scope unrecoverable. Only for
   * offboarding when data should be permanently deleted.
   */
  async function destroyKeys(): Promise<Result<void, ScopedKeyError>> {
    keyCache.delete(scope.value);
    await db.delete(table).where(eq(scopeColumn(), scope.value));
    return ok(undefined);
  }

  /** Invalidate cached keys (use after key rotation). */
  function invalidateCache(): void {
    keyCache.delete(scope.value);
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
