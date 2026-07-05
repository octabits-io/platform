import { type Result, toOctError } from '@octabits-io/foundation/result';
import type { ObjectStorageService, ObjectStorageUrlProvider } from '../../base/interfaces';
import type { ListObjectsResponse } from '../../base/types';
import type { ObjectStorageError } from '../../base/errors';
import { pgTable, text, jsonb, bigint, timestamp, index, customType, type PgDatabase } from 'drizzle-orm/pg-core';
import { eq, and, like, sql } from 'drizzle-orm';

/**
 * Minimal structural database type for the Postgres blob provider.
 *
 * The provider only ever uses the standard drizzle-orm query builder
 * (`select` / `insert` / `update` / `delete` / `execute` / `transaction`) and
 * references its own in-package `objectStorageTable` — it never touches a
 * host-application schema or the relational (`db.query.*`) API. Using
 * `PgDatabase<any, any, any>` keeps full query-builder type inference while
 * dropping any coupling to a specific app's augmented Drizzle instance —
 * schema-typed and wrapped host instances are assignable here.
 */
export type StorageDrizzle = PgDatabase<any, any, any>;

// Custom bytea type for storing binary data
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(value: Buffer): Buffer {
    return value;
  },
  toDriver(value: Buffer): Buffer {
    return value;
  },
});

// Schema definition for object storage. `namespace` is the optional logical
// partition from the ObjectStorageService contract; the root namespace is
// stored as '' (empty string) so the (namespace, key) unique constraint holds.
export const objectStorageTable = pgTable('object_storage', {
  id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  namespace: text('namespace').notNull().default(''),
  key: text('key').notNull(),
  data: bytea('data').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  contentType: text('content_type').notNull().default('application/octet-stream'),
  metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
  index('object_storage_namespace_key_idx').on(table.namespace, table.key),
  index('object_storage_namespace_idx').on(table.namespace),
]);

/** Root-namespace sentinel used only inside the table — never exposed to callers. */
const namespaceColumnValue = (namespace: string | undefined) => namespace ?? '';

// Configuration
export interface PostgresObjectStorageConfig {
  readonly drizzle: StorageDrizzle;
  createPublicUrl: (namespace: string | undefined, key: string) => string;
}

// URL provider config
export interface PostgresObjectStorageUrlProviderConfig {
  createPublicUrl: (namespace: string | undefined, key: string) => string;
  db: StorageDrizzle;
}

export interface PostgresObjectStorageUrlProvider extends ObjectStorageUrlProvider {
  readonly type: 'postgres';
  /** Available when drizzle was provided to the factory */
  readonly getObjectData?: ObjectStorageService['getObjectData'];
}

/**
 * Creates table initialization helper for a drizzle instance.
 * Extracted to be reusable by both URL provider and full service.
 */
const createTableInitializer = (db: StorageDrizzle) => {
  let initialized = false;

  return async (): Promise<Result<void, ObjectStorageError>> => {
    if (initialized) {
      return { ok: true, value: undefined };
    }

    try {
      await db.transaction(async (tx) => {
        const lockId = 123456789;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockId})`);

        await tx.execute(sql`
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
          )
        `);

        // Migrate tables created before the namespace rename (column was
        // tenant_id); data is preserved, only identifiers change.
        await tx.execute(sql`
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
          END $$;
        `);

        await tx.execute(sql`
          CREATE INDEX IF NOT EXISTS object_storage_namespace_key_idx
          ON object_storage (namespace, key)
        `);

        await tx.execute(sql`
          CREATE INDEX IF NOT EXISTS object_storage_namespace_idx
          ON object_storage (namespace)
        `);

        await tx.execute(sql`
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
          END $$;
        `);
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
 * Creates getObjectData implementation for a drizzle instance.
 */
const createGetObjectData = (db: StorageDrizzle, ensureTableExists: () => Promise<Result<void, ObjectStorageError>>): ObjectStorageService['getObjectData'] => {
  return async ({ namespace, key }: { namespace?: string; key: string }) => {
    const initResult = await ensureTableExists();
    if (!initResult.ok) {
      return initResult;
    }

    try {
      const result = await db
        .select({
          data: objectStorageTable.data,
          size: objectStorageTable.size,
          contentType: objectStorageTable.contentType,
          metadata: objectStorageTable.metadata,
          updatedAt: objectStorageTable.updatedAt,
        })
        .from(objectStorageTable)
        .where(
          and(
            eq(objectStorageTable.namespace, namespaceColumnValue(namespace)),
            eq(objectStorageTable.key, key)
          )
        )
        .limit(1);

      if (result.length === 0) {
        return {
          ok: false,
          error: {
            key: 'not_found',
            message: `Object not found: ${key}`,
          },
        };
      }

      const obj = result[0]!;

      return {
        ok: true,
        value: {
          data: obj.data,
          size: obj.size,
          contentType: obj.contentType,
          metadata: obj.metadata as Record<string, string>,
          lastModified: obj.updatedAt,
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

export const createPostgresObjectStorageUrlProvider = (config: PostgresObjectStorageUrlProviderConfig): PostgresObjectStorageUrlProvider => {
  const base = {
    type: 'postgres' as const,
    getPublicUrl: ({ namespace, key }: { namespace?: string; key: string }) => {
      return config.createPublicUrl(namespace, key);
    },
  };

  const ensureTableExists = createTableInitializer(config.db);
  const getObjectData = createGetObjectData(config.db, ensureTableExists);
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
export const createPostgresObjectStorageService = (config: PostgresObjectStorageConfig): PostgresObjectStorageService => {
  const { drizzle: db, createPublicUrl } = config;

  // Use shared table initializer
  const ensureTableExists = createTableInitializer(db);

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
      // Build query conditions
      const conditions = [eq(objectStorageTable.namespace, namespaceColumnValue(namespace))];

      if (prefix) {
        conditions.push(like(objectStorageTable.key, `${prefix}%`));
      }

      // Query objects
      const results = await db
        .select({
          key: objectStorageTable.key,
          size: objectStorageTable.size,
          contentType: objectStorageTable.contentType,
          metadata: objectStorageTable.metadata,
        })
        .from(objectStorageTable)
        .where(and(...conditions))
        .orderBy(objectStorageTable.key);

      if (includeHead) {
        const objects = results.map(row => ({
          key: row.key,
          size: row.size,
          contentType: row.contentType,
          metadata: row.metadata as Record<string, string>,
        }));

        return {
          ok: true,
          value: {
            continuationToken: undefined,
            objects: objects as unknown,
          } as ListObjectsResponse<T>,
        };
      }

      const objects = results.map(row => ({
        key: row.key,
        size: row.size,
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

      // Insert or update object
      const existing = await db
        .select({ id: objectStorageTable.id })
        .from(objectStorageTable)
        .where(
          and(
            eq(objectStorageTable.namespace, namespaceColumnValue(namespace)),
            eq(objectStorageTable.key, key)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        // Update existing
        await db
          .update(objectStorageTable)
          .set({
            data: buffer,
            size,
            contentType,
            metadata: metadata as Record<string, string>,
            updatedAt: sql`NOW()`,
          })
          .where(
            and(
              eq(objectStorageTable.namespace, namespaceColumnValue(namespace)),
              eq(objectStorageTable.key, key)
            )
          );
      } else {
        // Insert new
        await db.insert(objectStorageTable).values({
          namespace: namespaceColumnValue(namespace),
          key,
          data: buffer,
          size,
          contentType,
          metadata: metadata as Record<string, string>,
        });
      }

      return { ok: true, value: undefined };
    } catch (error) {
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
      await db
        .delete(objectStorageTable)
        .where(
          and(
            eq(objectStorageTable.namespace, namespaceColumnValue(namespace)),
            eq(objectStorageTable.key, key)
          )
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
    const initResult = await ensureTableExists();
    if (!initResult.ok) {
      return initResult;
    }

    try {
      const namespaceCondition = eq(objectStorageTable.namespace, namespaceColumnValue(namespace));
      const whereClause = prefix
        ? and(namespaceCondition, like(objectStorageTable.key, `${prefix}%`))
        : namespaceCondition;

      const result = await db
        .delete(objectStorageTable)
        .where(whereClause)
        .returning({ id: objectStorageTable.id });

      return { ok: true, value: { deleted: result.length } };
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
  const getObjectData = createGetObjectData(db, ensureTableExists);

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
