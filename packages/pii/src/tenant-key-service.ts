/**
 * Multi-tenant preset of the scoped key service (#34): binds the generic
 * `createScopedKeyService` to `{ column: 'tenantId', value: tenantId }` — the
 * shape of `@octabits-io/drizzle-toolkit/tenant`'s `tenantEncryptionKey`
 * table. Everything else (lazy generation, caching, master-key encryption)
 * lives in `./scoped-key-service.ts`.
 */
import {
  createScopedKeyService,
  type ScopedKeyCache,
  type ScopedKeyDb,
  type ScopedKeyService,
} from './scoped-key-service.ts';
import type { MasterKeyProvider } from './master-key.ts';

export interface TenantKeyServiceDeps {
  db: ScopedKeyDb;
  tenantId: string;
  masterKeyProvider: MasterKeyProvider;
  /** The tenant-encryption-key Drizzle table (columns per drizzle-toolkit/tenant). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Key of the table in `db.query` (e.g. 'tenantEncryptionKey'). */
  tableName: string;
  /** Decrypted-key cache (recommend LRU with ~5-minute TTL). */
  cache: ScopedKeyCache;
}

/**
 * Per-tenant encryption key service — the tenant preset of
 * {@link createScopedKeyService}, scoped to the table's `tenantId` column.
 */
export function createTenantKeyService({ tenantId, ...rest }: TenantKeyServiceDeps): ScopedKeyService {
  return createScopedKeyService({ ...rest, scope: { column: 'tenantId', value: tenantId } });
}

export type TenantKeyService = ScopedKeyService;
