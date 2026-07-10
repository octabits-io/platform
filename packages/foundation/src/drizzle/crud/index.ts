/**
 * Base CRUD Service Factory (#37)
 *
 * Generic factories for CRUD services over any Drizzle table with an `id`
 * column: `list` (paginated + total), `getById`, `create`, `update`,
 * `delete` — with consistent errors, pagination, and audit stamping.
 *
 * Two entry points, from generic to specific:
 * - `createBaseCrudService` — no scoping; works on any table with `id`.
 * - `createScopedCrudService` — every query auto-ANDed with
 *   `eq(table[scope.column], scope.value)` and `create()` force-injects the
 *   scope column, so row isolation holds by construction. The scope is a
 *   construction-time dependency (e.g. a per-request IoC scope), never a
 *   method argument. Bind whatever scope column partitions your app
 *   (`scope: { column: 'tenantId', value }`, `{ column: 'workspaceId', value }`, …).
 *
 * **Type Assertion Notes:** `as any` casts are used where Drizzle's type
 * system can't express the constraint (`(table as any).id` / dynamic scope
 * column, dynamic `db.query[tableName]`). They are safe by convention:
 * consuming tables carry `id` (+ the scope column when scoped), and
 * `tableName` must be a valid `db.query` key. Call-site type safety comes
 * from `$inferInsert`/`$inferSelect`.
 */
import { eq, and, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Result, OctError } from '../../result/index.ts';
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

/** Generic not-found error for CRUD resources. */
export interface ResourceNotFoundError extends OctError {
  key: string; // e.g. 'article_not_found'
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

/**
 * Row scope applied to every query of a scoped CRUD service: each statement
 * is ANDed with `eq(table[column], value)` and `create()` injects
 * `{ [column]: value }`. `column` is the **TypeScript property name** on the
 * Drizzle table (e.g. `'tenantId'`, `'workspaceId'`, `'ownerId'`), not the
 * SQL column name.
 */
export interface CrudScope<TScopeKey extends string = string> {
  column: TScopeKey;
  value: string;
}

/** Configuration shared by all CRUD service factories. */
export interface BaseCrudConfig<
  TTable extends PgTable,
  TEntity,
  TSelectColumns extends Record<string, boolean> = Record<string, boolean>
> {
  db: CrudDatabase;
  dateProvider: DateProvider;
  /**
   * Opaque actor id (e.g. the IdP user id), or `undefined` for
   * system/background scopes. When provided, stamped into `created_by` on
   * create() and `updated_by` on update(); silently ignored by Drizzle when
   * the table has no such column.
   */
  actorId?: string | undefined;
  table: TTable;
  tableName: string; // must match a key in db.query
  resourceName: string; // e.g. 'article' — used in not-found error keys
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

/** Configuration for a scoped CRUD service (base config + row scope). */
export interface ScopedCrudConfig<
  TTable extends PgTable,
  TEntity,
  TScopeKey extends string = string,
  TSelectColumns extends Record<string, boolean> = Record<string, boolean>
> extends BaseCrudConfig<TTable, TEntity, TSelectColumns> {
  scope: CrudScope<TScopeKey>;
}

/**
 * Base service interface for CRUD operations. Create/update parameter types
 * are inferred from the table via `$inferInsert`; `TOmitKey` removes the
 * scope column (injected by the service) from the caller-facing types.
 */
export interface BaseCrudService<
  TTable extends PgTable,
  TEntity,
  TOmitKey extends string = never
> {
  list(params?: ListPaginationParams): Promise<Result<PaginatedListResult<TEntity>, never>>;
  getById(params: { id: string }): Promise<Result<TEntity, ResourceNotFoundError>>;
  create(params: Omit<TTable['$inferInsert'], TOmitKey>): Promise<Result<void, OctDatabaseError>>;
  update(params: { id: string } & Partial<Omit<TTable['$inferInsert'], 'id' | TOmitKey>>): Promise<Result<void, ResourceNotFoundError | OctDatabaseError>>;
  delete(params: { id: string }): Promise<Result<void, ResourceNotFoundError | OctDatabaseError>>;
}

/** Shared implementation behind the two public factories. */
function buildCrudService<
  TTable extends PgTable,
  TEntity,
  TSelectColumns extends Record<string, boolean>
>(
  config: BaseCrudConfig<TTable, TEntity, TSelectColumns>,
  scope: CrudScope | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): BaseCrudService<TTable, TEntity, any> {
  const {
    db,
    dateProvider,
    actorId,
    table,
    tableName,
    resourceName,
    mapToEntity,
    selectColumns,
    listWhereConditions,
  } = config;

  const scopeCondition = (): SQL[] =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scope ? [eq((table as any)[scope.column], scope.value)] : [];

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
      ...scopeCondition(),
      ...(listWhereConditions?.() ?? []),
    ];
    const whereClause = whereConditions.length === 0
      ? undefined
      : whereConditions.length === 1 ? whereConditions[0] : and(...whereConditions);

    const countQuery = db
      .select({ count: sql<number>`count(*)::int` })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(table as any);
    const countResult = whereClause ? await countQuery.where(whereClause) : await countQuery;
    const total = countResult[0]?.count ?? 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queryOptions: any = { limit: normalizedLimit, offset };
    if (whereClause) queryOptions.where = whereClause;
    if (selectColumns) queryOptions.columns = selectColumns;

    const results = await db.query[tableName]!.findMany(queryOptions);

    return { ok: true, value: { items: results.map(mapToEntity), total } };
  }

  async function getById(params: { id: string }): Promise<Result<TEntity, ResourceNotFoundError>> {
    const whereClause = and(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq((table as any).id, params.id),
      ...scopeCondition(),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queryOptions: any = { where: whereClause };
    if (selectColumns) queryOptions.columns = selectColumns;

    const result = await db.query[tableName]!.findFirst(queryOptions);
    if (!result) return { ok: false, error: notFound(params.id) };
    return { ok: true, value: mapToEntity(result) };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function create(params: any): Promise<Result<void, OctDatabaseError>> {
    return withDbErrorHandling(async () => {
      // Inject the scope column + audit columns; createdBy/updatedBy only when
      // the calling scope has an actor (no-op for system writes).
      const dbValues = {
        ...params,
        ...(scope ? { [scope.column]: scope.value } : {}),
        ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}),
      } as TTable['$inferInsert'];

      await db.insert(table).values(dbValues);
      return { ok: true, value: undefined };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function update(params: any): Promise<Result<void, ResourceNotFoundError | OctDatabaseError>> {
    return withDbErrorHandling(async () => {
      const { id, ...updateData } = params;
      // Never let a payload smuggle the scope column into SET — that would
      // transfer the row to another scope. The type layer omits it, but
      // runtime callers (spread payloads, `as any`) must be stopped too.
      if (scope) delete updateData[scope.column];

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
            ...scopeCondition(),
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
            ...scopeCondition(),
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

/**
 * Create an unscoped CRUD service over a Drizzle table with an `id` column.
 * All rows in the table are visible; use `createScopedCrudService` when rows
 * must be partitioned by a column.
 */
export function createBaseCrudService<
  TTable extends PgTable,
  TEntity,
  TSelectColumns extends Record<string, boolean> = Record<string, boolean>
>(
  config: BaseCrudConfig<TTable, TEntity, TSelectColumns>
): BaseCrudService<TTable, TEntity> {
  return buildCrudService(config, undefined);
}

/**
 * Create a scoped CRUD service: every query is ANDed with
 * `eq(table[scope.column], scope.value)` and `create()` injects the scope
 * column, so isolation holds by construction. The scope column is removed
 * from the caller-facing create/update types.
 */
export function createScopedCrudService<
  TTable extends PgTable,
  TEntity,
  TScopeKey extends string,
  TSelectColumns extends Record<string, boolean> = Record<string, boolean>
>(
  config: ScopedCrudConfig<TTable, TEntity, TScopeKey, TSelectColumns>
): BaseCrudService<TTable, TEntity, TScopeKey> {
  const { scope, ...base } = config;
  return buildCrudService(base, scope);
}
