/**
 * Per-tenant Age keypair + blind-index HMAC key management (#34):
 * lazy auto-generation, cached decryption, `getKeys` / `hasKeys` /
 * `destroyKeys` / cache invalidation. Keys are stored encrypted with the
 * master key and cached in memory after decryption.
 *
 * Generic over the storage table: pass the tenant-encryption-key Drizzle
 * table (e.g. `@octabits-io/drizzle-toolkit/tenant`'s `tenantEncryptionKey`
 * or an app schema with the same columns) plus its `db.query` key. The cache
 * is injected (any `{ get/set/has/delete/clear }` — e.g. a foundation
 * LruCacheService cache with a 5-minute TTL).
 */
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { OctError, Result } from '@octabits-io/foundation/result';
import type { MasterKeyProvider, MasterKeyError } from './master-key.ts';
import { generateIdentity, identityToRecipient } from './typage/index.ts';

export interface TenantKeyNotFoundError extends OctError {
  key: 'tenant_keys_not_found';
  tenantId: string;
}

export interface TenantKeyGenerationError extends OctError {
  key: 'tenant_key_generation_error';
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

export type TenantKeyError = TenantKeyNotFoundError | TenantKeyGenerationError | MasterKeyError;

/** Decrypted tenant keys ready for use in encryption operations. */
export interface TenantKeys {
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
export interface TenantKeyCache {
  get(key: string): TenantKeys | undefined;
  set(key: string, value: TenantKeys): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
}

/** Structural row shape of the tenant-encryption-key table. */
interface TenantKeyRow {
  recipient: string;
  identityEncrypted: Buffer;
  blindIndexKeyEncrypted: Buffer;
  keyVersion: number;
}

/** Minimal structural db view (insert/delete + relational query namespace). */
export interface TenantKeyDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): { values(v: Record<string, unknown>): Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): { where(w: unknown): Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: Record<string, any>;
}

export interface TenantKeyServiceDeps {
  db: TenantKeyDb;
  /** Optional transaction-capable connection type for generateKeyPair(tx). */
  tenantId: string;
  masterKeyProvider: MasterKeyProvider;
  /** The tenant-encryption-key Drizzle table (columns per drizzle-toolkit/tenant). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Key of the table in `db.query` (e.g. 'tenantEncryptionKey'). */
  tableName: string;
  /** Decrypted-key cache (recommend LRU with ~5-minute TTL). */
  cache: TenantKeyCache;
}

/**
 * Service for managing per-tenant encryption keys: generation, cached
 * retrieval + decryption, destruction (offboarding), cache invalidation.
 */
export function createTenantKeyService({ db, tenantId, masterKeyProvider, table, tableName, cache }: TenantKeyServiceDeps) {
  const keyCache = cache;

  /**
   * Generate a new encryption key pair for a tenant. Call at tenant creation
   * (or rely on `getKeys`' lazy generation). Secrets are encrypted with the
   * master key before storage.
   *
   * @param tx - Optional transaction context (same structural shape as db)
   */
  async function generateKeyPair(
    tx?: TenantKeyDb,
  ): Promise<Result<void, TenantKeyError>> {
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
        tenantId,
        recipient,
        identityEncrypted: identityResult.value,
        blindIndexKeyEncrypted: blindKeyResult.value,
      });

      // Pre-populate cache
      keyCache.set(tenantId, { recipient, identity, blindIndexKey, keyVersion: 1 });

      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: {
          key: 'tenant_key_generation_error',
          message: `Failed to generate keys for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`,
          conflict: isUniqueViolation(error),
        },
      };
    }
  }

  /**
   * Get decrypted encryption keys for the tenant (cached after first
   * retrieval; lazily auto-generates on first use, retrying the fetch when a
   * concurrent request won the unique-constraint race).
   */
  async function getKeys(): Promise<Result<TenantKeys, TenantKeyError>> {
    const cached = keyCache.get(tenantId);
    if (cached) return { ok: true, value: cached };

    const row: TenantKeyRow | undefined = await db.query[tableName]!.findFirst({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: eq((table as any).tenantId, tenantId),
    });

    if (!row) {
      // Auto-generate keys for this tenant (lazy initialization)
      const genResult = await generateKeyPair();
      if (!genResult.ok) {
        // Unique-constraint violation = concurrent generation → retry fetch
        if (genResult.error.key === 'tenant_key_generation_error' && genResult.error.conflict) {
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

    const keys: TenantKeys = {
      recipient: row.recipient,
      identity: identityResult.value.toString('utf8'),
      blindIndexKey: blindKeyResult.value.toString('utf8'),
      keyVersion: row.keyVersion,
    };

    keyCache.set(tenantId, keys);
    return { ok: true, value: keys };
  }

  /** Check if the tenant has encryption keys. */
  async function hasKeys(): Promise<boolean> {
    if (keyCache.has(tenantId)) return true;
    const row = await db.query[tableName]!.findFirst({
      columns: { id: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: eq((table as any).tenantId, tenantId),
    });
    return row !== undefined;
  }

  /**
   * Destroy encryption keys for the tenant.
   *
   * WARNING: makes all encrypted data for this tenant unrecoverable. Only for
   * tenant offboarding when data should be permanently deleted.
   */
  async function destroyKeys(): Promise<Result<void, TenantKeyError>> {
    keyCache.delete(tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.delete(table).where(eq((table as any).tenantId, tenantId));
    return { ok: true, value: undefined };
  }

  /** Invalidate cached keys (use after key rotation). */
  function invalidateCache(): void {
    keyCache.delete(tenantId);
  }

  /** Clear the entire key cache (forces re-decryption for all tenants). */
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

export type TenantKeyService = ReturnType<typeof createTenantKeyService>;
