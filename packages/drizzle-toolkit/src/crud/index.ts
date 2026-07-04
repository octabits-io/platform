/**
 * Base Tenant-Scoped CRUD Service Factory (#37)
 *
 * A generic factory for tenant-scoped CRUD services over any Drizzle table
 * with `id` + `tenantId` columns: `list` (paginated + total), `getById`,
 * `create`, `update`, `delete` — every query auto-ANDed with
 * `eq(table.tenantId, tenantId)` so tenant isolation holds by construction.
 * `tenantId` is a construction-time dependency (per-request IoC scope), never
 * a method argument.
 *
 * **Type Assertion Notes:** `as any` casts are used where Drizzle's type
 * system can't express the constraint (`(table as any).id` / `.tenantId`,
 * dynamic `db.query[tableName]`). They are safe by convention: consuming
 * tables carry `id` + `tenantId`, and `tableName` must be a valid `db.query`
 * key. Call-site type safety comes from `$inferInsert`/`$inferSelect`.
 */
import { eq, and, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Result, OctError } from '@octabits-io/foundation/result';
import { withDbErrorHandling, normalizePaginationLimit, type OctDatabaseError } from '../db/index.ts';

/**
 * Clock-injection seam — structurally identical to
 * `@octabits-io/foundation/utils`' `DateProvider` (declared locally so this
 * package's foundation floor stays at 0.2.0).
 */
export interface DateProvider {
  now(): Date;
}

/**
 * Minimal structural view of an (augmented) Drizzle database — satisfied by
 * any `AppDatabase<TSchema>` from `./factory` and by transaction contexts.
 * Kept structural so instances from different drizzle copies interoperate.
 */
export interface CrudDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: Record<string, any>;
}

/** Generic not-found error for tenant-scoped resources. */
export interface ResourceNotFoundError extends OctError {
  key: string; // e.g. 'amenity_not_found'
  message: string;
}

/** Pagination parameters for list queries. */
export interface ListPaginationParams {
  /** Maximum items to return (default 50, normalized via pagination rules). */
  limit?: number;
  /** Number of items to skip (default 0). */
  offset?: number;
}

/** Paginated list result with total count. */
export interface PaginatedListResult<T> {
  items: T[];
  total: number;
}

/** Configuration for the base tenant-scoped CRUD service. */
export interface BaseTenantScopedCrudConfig<
  TTable extends PgTable,
  TEntity,
  TSelectColumns extends Record<string, boolean> = Record<string, boolean>
> {
  db: CrudDatabase;
  dateProvider: DateProvider;
  tenantId: string;
  /**
   * Opaque actor id (e.g. the IdP user id), or `undefined` for
   * system/background scopes. When provided, stamped into `created_by` on
   * create() and `updated_by` on update(); silently ignored by Drizzle when
   * the table has no such column.
   */
  actorId?: string | undefined;
  table: TTable;
  tableName: string; // must match a key in db.query
  resourceName: string; // e.g. 'amenity' — used in not-found error keys
  /**
   * Optional columns to select for list/getById queries (all columns when
   * omitted). Keys must be table columns.
   */
  selectColumns?: TSelectColumns;
  /** Map a database row to the entity type. */
  mapToEntity: (dbResult: TTable['$inferSelect']) => TEntity;
  /** Optional additional where conditions for list queries. */
  listWhereConditions?: () => SQL[];
}

/**
 * Base service interface for tenant-scoped CRUD operations. Create/update
 * parameter types are inferred from the table via `$inferInsert`.
 */
export interface BaseTenantScopedCrudService<
  TTable extends PgTable,
  TEntity
> {
  list(params?: ListPaginationParams): Promise<Result<PaginatedListResult<TEntity>, never>>;
  getById(params: { id: string }): Promise<Result<TEntity, ResourceNotFoundError>>;
  create(params: Omit<TTable['$inferInsert'], 'tenantId'>): Promise<Result<void, OctDatabaseError>>;
  update(params: { id: string } & Partial<Omit<TTable['$inferInsert'], 'id' | 'tenantId'>>): Promise<Result<void, ResourceNotFoundError | OctDatabaseError>>;
  delete(params: { id: string }): Promise<Result<void, ResourceNotFoundError | OctDatabaseError>>;
}

/**
 * Create a tenant-scoped CRUD service over a Drizzle table with
 * `id` + `tenantId` columns. Eliminates the per-resource boilerplate for
 * simple admin CRUD (consistent errors, pagination, audit stamping).
 */
export function createBaseTenantScopedCrudService<
  TTable extends PgTable,
  TEntity,
  TSelectColumns extends Record<string, boolean> = Record<string, boolean>
>(
  config: BaseTenantScopedCrudConfig<TTable, TEntity, TSelectColumns>
): BaseTenantScopedCrudService<TTable, TEntity> {
  const {
    db,
    dateProvider,
    tenantId,
    actorId,
    table,
    tableName,
    resourceName,
    mapToEntity,
    selectColumns,
    listWhereConditions,
  } = config;

  function notFound(id: string): ResourceNotFoundError {
    return {
      key: `${resourceName}_not_found`,
      message: `${resourceName.charAt(0).toUpperCase() + resourceName.slice(1)} ${id} not found`,
    };
  }

  async function list(
    params?: ListPaginationParams
  ): Promise<Result<PaginatedListResult<TEntity>, never>> {
    const { limit = 50, offset = 0 } = params ?? {};
    const normalizedLimit = normalizePaginationLimit(limit);

    const whereConditions = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq((table as any).tenantId, tenantId),
      ...(listWhereConditions?.() ?? []),
    ];
    const whereClause = whereConditions.length === 1 ? whereConditions[0] : and(...whereConditions);

    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(table as any)
      .where(whereClause);
    const total = countResult[0]?.count ?? 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queryOptions: any = { where: whereClause, limit: normalizedLimit, offset };
    if (selectColumns) queryOptions.columns = selectColumns;

    const results = await db.query[tableName]!.findMany(queryOptions);

    return { ok: true, value: { items: results.map(mapToEntity), total } };
  }

  async function getById(params: { id: string }): Promise<Result<TEntity, ResourceNotFoundError>> {
    const whereClause = and(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq((table as any).id, params.id),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq((table as any).tenantId, tenantId),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queryOptions: any = { where: whereClause };
    if (selectColumns) queryOptions.columns = selectColumns;

    const result = await db.query[tableName]!.findFirst(queryOptions);
    if (!result) return { ok: false, error: notFound(params.id) };
    return { ok: true, value: mapToEntity(result) };
  }

  async function create(params: Omit<TTable['$inferInsert'], 'tenantId'>): Promise<Result<void, OctDatabaseError>> {
    return withDbErrorHandling(async () => {
      // Inject tenantId + audit columns; createdBy/updatedBy only when the
      // calling scope has an actor (no-op for system writes).
      const dbValues = {
        ...params,
        tenantId,
        ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}),
      } as TTable['$inferInsert'];

      await db.insert(table).values(dbValues);
      return { ok: true, value: undefined };
    });
  }

  async function update(params: { id: string } & Partial<Omit<TTable['$inferInsert'], 'id' | 'tenantId'>>): Promise<Result<void, ResourceNotFoundError | OctDatabaseError>> {
    return withDbErrorHandling(async () => {
      const { id, ...updateData } = params;

      const result = await db.update(table)
        .set({
          ...updateData,
          updatedAt: dateProvider.now(),
          ...(actorId ? { updatedBy: actorId } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        .where(
          and(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eq((table as any).id, id),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eq((table as any).tenantId, tenantId),
          )
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .returning({ id: (table as any).id });

      if (!result || result.length === 0) return { ok: false, error: notFound(id) };
      return { ok: true, value: undefined };
    });
  }

  async function deleteResource(params: { id: string }): Promise<Result<void, ResourceNotFoundError | OctDatabaseError>> {
    return withDbErrorHandling(async () => {
      const result = await db.delete(table)
        .where(
          and(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eq((table as any).id, params.id),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eq((table as any).tenantId, tenantId),
          )
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .returning({ id: (table as any).id });

      if (!result || result.length === 0) return { ok: false, error: notFound(params.id) };
      return { ok: true, value: undefined };
    });
  }

  return { list, getById, create, update, delete: deleteResource };
}
