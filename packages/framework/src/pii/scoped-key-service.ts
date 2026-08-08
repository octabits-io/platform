/**
 * Per-scope Age keypair + blind-index HMAC key management: lazy
 * auto-generation, cached decryption, `getKeys` / `hasKeys` / `destroyKeys` /
 * cache invalidation. Keys are stored encrypted with the master key and
 * cached in memory after decryption.
 *
 * **Storage is a structural seam, not a database.** This service owns the
 * encryption logic and knows nothing about SQL, drivers, or SQLSTATEs — it
 * depends on a four-method `ScopedKeyStore` (`insert` / `find` / `exists` /
 * `destroy`), scope-bound at construction. The store maps its own failures to
 * two neutral outcomes: a lost unique race (`scoped_key_store_conflict`) vs any
 * other failure (`scoped_key_store_failure`); this service translates those to
 * its unchanged public error surface. Because the seam is structural (same
 * pattern as `flow`'s `AiQuotaStore` or `./drizzle/config`'s `ConfigCipher`),
 * `@octabits-io/framework/pii` needs no ORM peer — the Postgres/Drizzle implementation
 * lives in
 * [`@octabits-io/framework/drizzle/scoped-key-store`](../drizzle/scoped-key-store)
 * (`createDrizzleScopedKeyStore`); tests here use in-memory mock stores.
 *
 * Generic over the scope: one service instance is bound to one
 * `{ column, value }` scope. The `scope` is kept ONLY for cache keying and
 * error messages — it MUST match the scope the store is bound to.
 */
import crypto from 'node:crypto';
import { type OctError, type Result, ok, err } from '../result/index.ts';
import type { Logger } from '../logger/index.ts';
import type { DateProvider } from '../utils/DateProvider.ts';
import type { MasterKeyProvider, MasterKeyProviderError } from './master-key.ts';
import { generateIdentity, identityToRecipient } from './typage/index.ts';

/** The `{ column, value }` pair a key-service instance is bound to. */
export interface KeyScope {
  /**
   * Scope column identifier (e.g. `'tenantId'`, `'workspaceId'`). Used only for
   * cache keying + error messages here; the store owns the actual SQL binding.
   */
  column: string;
  /** Scope value (e.g. the tenant id). */
  value: string;
}

// ---------------------------------------------------------------------------
// Storage seam (structural — no ORM/driver types leak in)
// ---------------------------------------------------------------------------

/** New key row this service hands to the store — the store stamps the scope. */
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
 * Structural, scope-bound key store. Every method is already bound to one
 * scope; this service passes no scope arguments. A lost unique race on
 * `insert` MUST surface as `scoped_key_store_conflict` (drives concurrent-
 * generation recovery); `find` returns `null` for expected absence (drives
 * lazy generation).
 */
export interface ScopedKeyStore {
  insert(row: NewScopedKeyRow): Promise<Result<void, ScopedKeyStoreError>>;
  find(): Promise<Result<ScopedKeyRow | null, ScopedKeyStoreError>>;
  exists(): Promise<Result<boolean, ScopedKeyStoreError>>;
  destroy(): Promise<Result<void, ScopedKeyStoreError>>;
}

// ---------------------------------------------------------------------------
// Public error surface (unchanged)
// ---------------------------------------------------------------------------

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

/**
 * Structural cache seam — satisfied by foundation's `LruCache`.
 *
 * Deliberately has no `has`: every read goes through the service's own TTL
 * check (see {@link ScopedKeyServiceDeps.cacheTtlMs}), and a `has` that
 * answered `true` for an entry the service considers expired would be a way
 * around it. Storage and eviction only.
 */
export interface ScopedKeyCache {
  get(key: string): ScopedKeys | undefined;
  set(key: string, value: ScopedKeys): void;
  delete(key: string): boolean;
  clear(): void;
}

/**
 * Default lifetime of a decrypted-key cache entry (5 minutes).
 *
 * Decrypted keys are plaintext age identities held as JS strings — not
 * zeroizable, and visible in a heap or core dump for as long as they are
 * cached. The TTL bounds that exposure, and it is also the window in which a
 * process still serves keys another process has already destroyed (see
 * {@link ScopedKeyServiceDeps.onKeysDestroyed}).
 */
export const DEFAULT_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ScopedKeyServiceDeps {
  /**
   * Scope-bound storage seam. Construct one for the service's scope — e.g.
   * `createDrizzleScopedKeyStore({ db, table, scope })` from
   * `@octabits-io/framework/drizzle/scoped-key-store`.
   */
  store: ScopedKeyStore;
  /**
   * Scope this instance is bound to (column identifier + value). Kept for cache
   * keying + error messages; MUST match the scope the `store` is bound to.
   */
  scope: KeyScope;
  masterKeyProvider: MasterKeyProvider;
  /**
   * Decrypted-key cache.
   *
   * Cache entries are keyed by `encodeURIComponent(column):encodeURIComponent(value)`,
   * NOT by the store. WARNING: do not share one cache instance across services
   * whose stores persist keys in DIFFERENT tables under the same scope
   * column+value — their entries would collide. Use one cache per key store.
   *
   * The cache's own eviction policy is not trusted for expiry — the service
   * enforces {@link ScopedKeyServiceDeps.cacheTtlMs} itself, so passing a plain
   * `Map` cannot end up pinning decrypted keys in memory forever.
   */
  cache: ScopedKeyCache;
  /**
   * How long a decrypted-key cache entry stays valid, in ms. Defaults to
   * {@link DEFAULT_KEY_CACHE_TTL_MS} (5 minutes). Enforced by the service on
   * every read, independently of the injected cache's own TTL (if it has one).
   *
   * `0` disables expiry — only for tests and short-lived processes: it pins
   * plaintext age identities in memory for the process's lifetime and removes
   * the upper bound on how long a destroyed scope's keys stay usable here.
   */
  cacheTtlMs?: number;
  /** Clock seam for the TTL. Defaults to `Date.now()`. */
  dateProvider?: DateProvider;
  /**
   * Called after {@link ScopedKeyService.destroyKeys} deletes the key row —
   * the cross-process invalidation seam.
   *
   * `destroyKeys` is crypto-shredding, but it can only drop the *calling*
   * process's cache. Every other process (pod, worker, replica) keeps serving
   * decrypted keys for the rest of its `cacheTtlMs` — a real window on an
   * offboarding or erasure path. Wire this to a broadcast the other processes
   * listen on (`./events`' ephemeral lane, a `pg_notify` channel, your bus)
   * and have each receiver call `invalidateCache()`, and the window closes.
   *
   * Left unset, `cacheTtlMs` is your only bound. Failures are logged and
   * contained: the key row is already gone, so the destroy still succeeds.
   */
  onKeysDestroyed?: (scope: KeyScope) => void | Promise<void>;
  /** Used only to report a failing `onKeysDestroyed` broadcast. */
  logger?: Logger;
}

/**
 * Service for managing per-scope encryption keys: generation, cached
 * retrieval + decryption, destruction (offboarding), cache invalidation.
 */
export function createScopedKeyService({
  store,
  scope,
  masterKeyProvider,
  cache,
  cacheTtlMs = DEFAULT_KEY_CACHE_TTL_MS,
  dateProvider,
  onKeysDestroyed,
  logger,
}: ScopedKeyServiceDeps) {
  const keyCache = cache;
  // Qualified cache key: scope value alone would collide across services bound
  // to different scope columns (e.g. workspaceId 'x' vs tenantId 'x').
  const cacheKey = `${encodeURIComponent(scope.column)}:${encodeURIComponent(scope.value)}`;
  const now = () => (dateProvider ? dateProvider.now().getTime() : Date.now());

  // One service instance is bound to one scope, so the whole cache state this
  // service owns is a single expiry stamp. Expiry lives HERE rather than in
  // the injected cache: the seam is structural, so a consumer can satisfy it
  // with a plain Map, and then nothing would ever evict a decrypted identity.
  let cacheExpiresAt = 0;

  /** Cache read that treats an expired entry as a miss (and evicts it). */
  function readCache(): ScopedKeys | undefined {
    const cached = keyCache.get(cacheKey);
    if (cached === undefined) return undefined;
    if (cacheTtlMs > 0 && now() >= cacheExpiresAt) {
      dropCache();
      return undefined;
    }
    return cached;
  }

  function writeCache(keys: ScopedKeys): void {
    keyCache.set(cacheKey, keys);
    cacheExpiresAt = cacheTtlMs > 0 ? now() + cacheTtlMs : Number.POSITIVE_INFINITY;
  }

  function dropCache(): void {
    keyCache.delete(cacheKey);
    cacheExpiresAt = 0;
  }

  /**
   * Generate a new encryption key pair for the scope. Call at scope creation
   * (or rely on `getKeys`' lazy generation). Secrets are encrypted with the
   * master key before storage.
   *
   * @param txStore - Optional transaction-bound store (e.g.
   *   `store.withDb(tx)`). When provided, the decrypted-key cache is NOT
   *   pre-populated — the caller's transaction may still roll back, and a
   *   cached never-persisted key would make future encryptions unrecoverable.
   *   The cache is populated on the next `getKeys()` read instead.
   */
  async function generateKeyPair(
    txStore?: ScopedKeyStore,
  ): Promise<Result<void, ScopedKeyError>> {
    // Defensive outer catch: the store returns Result and should not throw, but
    // this service must never throw for expected failures.
    try {
      const activeStore = txStore ?? store;

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

      // Persist through the seam — the store stamps the scope column.
      const insertResult = await activeStore.insert({
        recipient,
        identityEncrypted: identityResult.value,
        blindIndexKeyEncrypted: blindKeyResult.value,
      });
      if (!insertResult.ok) {
        return err({
          key: 'scoped_key_generation_error',
          message: `Failed to generate keys for ${scope.column}=${scope.value}: ${insertResult.error.message}`,
          conflict: insertResult.error.key === 'scoped_key_store_conflict',
        });
      }

      // Pre-populate the cache only when the insert went through the service's
      // own (auto-committing) store — never inside a caller transaction that
      // may still roll back. Read the row back so the cached keyVersion is the
      // actually-persisted one (DB default/trigger), not a hardcoded guess. If
      // the read-back fails, skip caching — the next getKeys() populates it.
      if (!txStore) {
        const rowResult = await store.find();
        if (rowResult.ok && rowResult.value) {
          writeCache({ recipient, identity, blindIndexKey, keyVersion: rowResult.value.keyVersion });
        }
      }

      return ok(undefined);
    } catch (error) {
      return err({
        key: 'scoped_key_generation_error',
        message: `Failed to generate keys for ${scope.column}=${scope.value}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function getKeysInner(depth: number): Promise<Result<ScopedKeys, ScopedKeyError>> {
    const cached = readCache();
    if (cached) return ok(cached);

    const rowResult = await store.find();
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

    writeCache(keys);
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
    if (readCache() !== undefined) return ok(true);
    const existsResult = await store.exists();
    if (!existsResult.ok) {
      return err({
        key: 'scoped_key_storage_error',
        message: `Failed to check keys for ${scope.column}=${scope.value}: ${existsResult.error.message}`,
      });
    }
    return ok(existsResult.value);
  }

  /**
   * Destroy encryption keys for the scope.
   *
   * WARNING: makes all encrypted data for this scope unrecoverable. Only for
   * offboarding when data should be permanently deleted.
   *
   * Drops THIS process's cache and fires `onKeysDestroyed`. Without that hook,
   * other processes keep serving their cached copy for up to `cacheTtlMs` —
   * see {@link ScopedKeyServiceDeps.onKeysDestroyed}.
   */
  async function destroyKeys(): Promise<Result<void, ScopedKeyError>> {
    dropCache();
    const deleteResult = await store.destroy();
    if (!deleteResult.ok) {
      return err({
        key: 'scoped_key_storage_error',
        message: `Failed to destroy keys for ${scope.column}=${scope.value}: ${deleteResult.error.message}`,
      });
    }
    if (onKeysDestroyed) {
      // The row is already gone — a failed broadcast must not report the
      // destroy as failed. It degrades to TTL-bounded staleness elsewhere,
      // which is worth a loud log line.
      try {
        await onKeysDestroyed(scope);
      } catch (error) {
        logger?.error(
          `Failed to broadcast key destruction for ${scope.column}=${scope.value} — other processes may serve cached keys for up to ${cacheTtlMs}ms`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return ok(undefined);
  }

  /**
   * Invalidate cached keys (use after key rotation, and on receipt of another
   * process's `onKeysDestroyed` broadcast).
   */
  function invalidateCache(): void {
    dropCache();
  }

  /** Clear the entire key cache (forces re-decryption for all scopes). */
  function clearCache(): void {
    keyCache.clear();
    cacheExpiresAt = 0;
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
