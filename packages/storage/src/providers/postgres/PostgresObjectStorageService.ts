import { type Result, toOctError } from '@octabits-io/foundation/result';
import type { ObjectStorageService, ObjectStorageUrlProvider } from '../../base/interfaces';
import type { ListObjectsResponse } from '../../base/types';
import type { ObjectStorageError } from '../../base/errors';
import type { Pool, PoolClient } from 'pg';

/**
 * Postgres blob provider on raw `pg` (nominal `Pool` type, optional peer).
 *
 * Stores blobs in a self-owned `object_storage` table. `namespace` is the
 * optional logical partition from the ObjectStorageService contract; the root
 * namespace is stored as `''` (empty string) so the `(namespace, key)` unique
 * constraint holds. Modeled on `packages/flow/src/store-pg/store.ts` — `$n`
 * params, snake_case rows, `Number()` for `bigint`-as-string, `iso()` for Date.
 */

/** `timestamptz` comes back from `pg` as a `Date`; normalize to ISO 8601 text. */
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v);

/** Root-namespace sentinel used only inside the table — never exposed to callers. */
const namespaceColumnValue = (namespace: string | undefined): string => namespace ?? '';

// --- schema (DDL) ----------------------------------------------------------

/** `CREATE TABLE IF NOT EXISTS` for the blob table. */
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS object_storage (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  namespace TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  data BYTEA NOT NULL,
  size BIGINT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);`;

/**
 * Migrate tables created before the namespace rename (column was `tenant_id`);
 * data is preserved, only identifiers change. Kept **private** — it runs only
 * inside the lazy initializer, never in the migration-managed `objectStorageDdl()`.
 */
const RENAME_MIGRATION = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'object_storage' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE object_storage RENAME COLUMN tenant_id TO namespace;
    ALTER TABLE object_storage ALTER COLUMN namespace SET DEFAULT '';
    ALTER INDEX IF EXISTS object_storage_tenant_id_key_idx RENAME TO object_storage_namespace_key_idx;
    ALTER INDEX IF EXISTS object_storage_tenant_id_idx RENAME TO object_storage_namespace_idx;
    IF EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'object_storage_tenant_id_key_unique'
    ) THEN
      ALTER TABLE object_storage RENAME CONSTRAINT object_storage_tenant_id_key_unique TO object_storage_namespace_key_unique;
    END IF;
  END IF;
END $$;`;

/** Lookup index on `(namespace, key)`. */
const INDEX_A = `
CREATE INDEX IF NOT EXISTS object_storage_namespace_key_idx
ON object_storage (namespace, key);`;

/** Listing index on `(namespace)`. */
const INDEX_B = `
CREATE INDEX IF NOT EXISTS object_storage_namespace_idx
ON object_storage (namespace);`;

/**
 * The `(namespace, key)` unique constraint that `uploadObject`'s upsert
 * (`ON CONFLICT (namespace, key)`) depends on. Added idempotently.
 */
const UNIQUE_CONSTRAINT = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'object_storage_namespace_key_unique'
  ) THEN
    ALTER TABLE object_storage
    ADD CONSTRAINT object_storage_namespace_key_unique
    UNIQUE (namespace, key);
  END IF;
END $$;`;

/** Statements the lazy initializer runs, in order (includes the legacy rename). */
const INITIALIZER_STATEMENTS = [CREATE_TABLE, RENAME_MIGRATION, INDEX_A, INDEX_B, UNIQUE_CONSTRAINT];

/**
 * Full schema for the Postgres blob store, for migration-managed setups that
 * disable the lazy bootstrap (`autoCreateTable: false`). Emits the
 * `CREATE TABLE`, both indexes, and the `(namespace, key)` unique constraint —
 * the last is **required** for `uploadObject`'s upsert. Excludes the private
 * legacy `tenant_id → namespace` rename (initializer-only).
 */
export function objectStorageDdl(): string {
  return [CREATE_TABLE, INDEX_A, INDEX_B, UNIQUE_CONSTRAINT].join('\n');
}

// --- row types -------------------------------------------------------------

/** Raw `object_storage` row from a full-object read (`bigint`→string, `timestamptz`→Date). */
type ObjectRow = {
  data: Buffer;
  size: string;
  content_type: string;
  metadata: Record<string, string> | null;
  updated_at: Date;
};

/** Raw `object_storage` row from a list read. */
type ListRow = {
  key: string;
  size: string;
  content_type: string;
  metadata: Record<string, string> | null;
};

// --- config ----------------------------------------------------------------

/**
 * Options controlling the lazy `CREATE TABLE IF NOT EXISTS` bootstrap that
 * runs before the first storage operation.
 */
export interface TableInitializerOptions {
  /**
   * Run the DDL bootstrap lazily before the first operation. Default `true`.
   *
   * When enabled, EVERY operation — including plain reads — may trigger DDL
   * on first use, so the connected role needs DDL privileges. Set to `false`
   * when the `object_storage` table is managed by migrations (apply
   * `objectStorageDdl()`); the provider then never issues DDL at runtime.
   */
  readonly autoCreateTable?: boolean;
  /**
   * `pg_advisory_xact_lock` id used to serialize concurrent table
   * initialization across instances. Default `123456789`. Override it if that
   * id collides with an advisory lock used elsewhere in your system.
   */
  readonly advisoryLockId?: number;
}

// Configuration — a raw `pg` Pool for both the full service and the URL provider.
export interface PostgresObjectStorageConfig extends TableInitializerOptions {
  readonly pool: Pool;
  createPublicUrl: (namespace: string | undefined, key: string) => string;
}

// URL provider config — same `{ pool }` shape as the full service config.
export interface PostgresObjectStorageUrlProviderConfig extends TableInitializerOptions {
  createPublicUrl: (namespace: string | undefined, key: string) => string;
  readonly pool: Pool;
}

export interface PostgresObjectStorageUrlProvider extends ObjectStorageUrlProvider {
  readonly type: 'postgres';
  /** Reads the stored blob (available on the URL provider too). */
  readonly getObjectData?: ObjectStorageService['getObjectData'];
}

// --- transaction + initializer helpers -------------------------------------

/** Run `fn` inside a BEGIN/COMMIT transaction on a dedicated client (copied from flow). */
async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const DEFAULT_ADVISORY_LOCK_ID = 123456789;

/**
 * Builds a memoized lazy table initializer. The first call runs the full DDL
 * bootstrap (advisory-locked, in one transaction); subsequent calls are no-ops.
 * Skipped entirely when `autoCreateTable: false`.
 */
const createTableInitializer = (pool: Pool, options?: TableInitializerOptions) => {
  const autoCreateTable = options?.autoCreateTable ?? true;
  const lockId = options?.advisoryLockId ?? DEFAULT_ADVISORY_LOCK_ID;
  let initialized = false;

  return async (): Promise<Result<void, ObjectStorageError>> => {
    if (!autoCreateTable || initialized) {
      return { ok: true, value: undefined };
    }

    try {
      await withTx(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
        for (const stmt of INITIALIZER_STATEMENTS) {
          await client.query(stmt);
        }
      });

      initialized = true;
      return { ok: true, value: undefined };
    } catch (error) {
      const octError = toOctError(error);
      return {
        ok: false,
        error: {
          key: 'internal_error',
          message: `Failed to initialize object storage table: ${octError.message}`,
        },
      };
    }
  };
};

/**
 * Creates a `getObjectData` implementation bound to a pool. Reusable by both
 * the URL provider and the full service.
 */
const createGetObjectData = (
  pool: Pool,
  ensureTableExists: () => Promise<Result<void, ObjectStorageError>>,
): ObjectStorageService['getObjectData'] => {
  return async ({ namespace, key }: { namespace?: string; key: string }) => {
    const initResult = await ensureTableExists();
    if (!initResult.ok) {
      return initResult;
    }

    try {
      const result = await pool.query<ObjectRow>(
        `SELECT data, size, content_type, metadata, updated_at FROM object_storage WHERE namespace = $1 AND key = $2 LIMIT 1`,
        [namespaceColumnValue(namespace), key],
      );

      if (result.rows.length === 0) {
        return {
          ok: false,
          error: {
            key: 'not_found',
            message: `Object not found: ${key}`,
          },
        };
      }

      const obj = result.rows[0]!;

      return {
        ok: true,
        value: {
          data: obj.data,
          size: Number(obj.size),
          contentType: obj.content_type,
          metadata: obj.metadata ?? {},
          lastModified: iso(obj.updated_at),
        },
      };
    } catch (error) {
      const octError = toOctError(error);
      return {
        ok: false,
        error: {
          key: 'internal_error',
          message: `Failed to retrieve object '${key}': ${octError.message}`,
        },
      };
    }
  };
};

export const createPostgresObjectStorageUrlProvider = (
  config: PostgresObjectStorageUrlProviderConfig,
): PostgresObjectStorageUrlProvider => {
  const base = {
    type: 'postgres' as const,
    getPublicUrl: ({ namespace, key }: { namespace?: string; key: string }) => {
      return config.createPublicUrl(namespace, key);
    },
  };

  const ensureTableExists = createTableInitializer(config.pool, config);
  const getObjectData = createGetObjectData(config.pool, ensureTableExists);
  return { ...base, getObjectData };
};

// Helper to convert stream to buffer
const streamToBuffer = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const buffer = Buffer.allocUnsafe(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  return buffer;
};

export interface PostgresObjectStorageService extends ObjectStorageService {
  readonly type: 'postgres';
}

// Service implementation
export const createPostgresObjectStorageService = (
  config: PostgresObjectStorageConfig,
): PostgresObjectStorageService => {
  const { pool, createPublicUrl } = config;

  // Use shared table initializer
  const ensureTableExists = createTableInitializer(pool, config);

  const getPublicUrl: ObjectStorageService['getPublicUrl'] = ({ namespace, key }) => {
    return createPublicUrl(namespace, key);
  };

  const listObjects: ObjectStorageService['listObjects'] = async <T extends boolean>({ namespace, prefix, includeHead }: {
    namespace?: string;
    prefix?: string;
    includeHead: T;
  }) => {
    const initResult = await ensureTableExists();
    if (!initResult.ok) {
      return initResult;
    }

    try {
      const conds = ['namespace = $1'];
      const args: unknown[] = [namespaceColumnValue(namespace)];
      if (prefix) {
        args.push(`${prefix}%`);
        conds.push(`key LIKE $${args.length}`);
      }

      const results = await pool.query<ListRow>(
        `SELECT key, size, content_type, metadata FROM object_storage WHERE ${conds.join(' AND ')} ORDER BY key`,
        args,
      );

      if (includeHead) {
        const objects = results.rows.map((row: ListRow) => ({
          key: row.key,
          size: Number(row.size),
          contentType: row.content_type,
          metadata: row.metadata ?? {},
        }));

        return {
          ok: true,
          value: {
            continuationToken: undefined,
            objects: objects as unknown,
          } as ListObjectsResponse<T>,
        };
      }

      const objects = results.rows.map((row: ListRow) => ({
        key: row.key,
        size: Number(row.size),
      }));

      return {
        ok: true,
        value: {
          continuationToken: undefined,
          objects: objects as unknown,
        } as ListObjectsResponse<T>,
      };
    } catch (error) {
      const octError = toOctError(error);
      return {
        ok: false,
        error: {
          key: 'internal_error',
          message: `Failed to list objects: ${octError.message}`,
        },
      };
    }
  };

  const uploadObject: ObjectStorageService['uploadObject'] = async ({ namespace, key, metadata: inputMetadata, body }: {
    namespace?: string;
    key: string;
    metadata?: { readonly [key: string]: string };
    body: Uint8Array | ReadableStream<Uint8Array>;
  }) => {
    const initResult = await ensureTableExists();
    if (!initResult.ok) {
      return initResult;
    }

    try {
      // Convert body to buffer
      let buffer: Buffer;
      if (body instanceof Uint8Array) {
        buffer = Buffer.from(body);
      } else {
        buffer = await streamToBuffer(body);
      }

      const size = buffer.length;
      const metadata = inputMetadata || {};

      // Try to detect content type from metadata or default
      const contentType = metadata['content-type'] || metadata['contentType'] || 'application/octet-stream';

      // Single atomic upsert (also fixes the old select-then-write race). Relies
      // on the object_storage_namespace_key_unique constraint from the initializer
      // / objectStorageDdl().
      await pool.query(
        `INSERT INTO object_storage (namespace, key, data, size, content_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (namespace, key) DO UPDATE SET
           data = EXCLUDED.data,
           size = EXCLUDED.size,
           content_type = EXCLUDED.content_type,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()`,
        [namespaceColumnValue(namespace), key, buffer, size, contentType, JSON.stringify(metadata)],
      );

      return { ok: true, value: undefined };
    } catch (error) {
      // 42P10 = there is no unique/exclusion constraint matching ON CONFLICT.
      // A legacy table with autoCreateTable:false lacks the unique constraint.
      if ((error as { code?: string } | null)?.code === '42P10') {
        return {
          ok: false,
          error: {
            key: 'internal_error',
            message: `Failed to upload object '${key}': missing object_storage_namespace_key_unique constraint — apply objectStorageDdl() or enable autoCreateTable`,
          },
        };
      }
      const octError = toOctError(error);
      return {
        ok: false,
        error: {
          key: 'internal_error',
          message: `Failed to upload object '${key}': ${octError.message}`,
        },
      };
    }
  };

  const deleteObject: ObjectStorageService['deleteObject'] = async ({ namespace, key }: { namespace?: string; key: string }) => {
    const initResult = await ensureTableExists();
    if (!initResult.ok) {
      return initResult;
    }

    try {
      await pool.query(
        `DELETE FROM object_storage WHERE namespace = $1 AND key = $2`,
        [namespaceColumnValue(namespace), key],
      );

      // Treat as success even if object doesn't exist (idempotent delete)
      return { ok: true, value: undefined };
    } catch (error) {
      const octError = toOctError(error);
      return {
        ok: false,
        error: {
          key: 'internal_error',
          message: `Failed to delete object '${key}': ${octError.message}`,
        },
      };
    }
  };

  const deleteObjectsByPrefix: ObjectStorageService['deleteObjectsByPrefix'] = async ({ namespace, prefix }: { namespace?: string; prefix?: string }) => {
    // Safety: without a prefix this would delete every object in the
    // namespace. Require an explicit prefix.
    if (!prefix) {
      return {
        ok: false,
        error: {
          key: 'invalid_prefix',
          message: "deleteObjectsByPrefix requires a non-empty 'prefix' — a missing prefix would delete every object in the namespace",
        },
      };
    }

    const initResult = await ensureTableExists();
    if (!initResult.ok) {
      return initResult;
    }

    try {
      const result = await pool.query(
        `DELETE FROM object_storage WHERE namespace = $1 AND key LIKE $2`,
        [namespaceColumnValue(namespace), `${prefix}%`],
      );

      return { ok: true, value: { deleted: result.rowCount ?? 0 } };
    } catch (error) {
      const octError = toOctError(error);
      return {
        ok: false,
        error: {
          key: 'internal_error',
          message: `Failed to delete objects in namespace '${namespace ?? '(root)'}': ${octError.message}`,
        },
      };
    }
  };

  // Use shared getObjectData implementation
  const getObjectData = createGetObjectData(pool, ensureTableExists);

  return {
    type: 'postgres' as const,
    getPublicUrl,
    listObjects,
    uploadObject,
    deleteObject,
    deleteObjectsByPrefix,
    getObjectData,
  };
};
