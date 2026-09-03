// @octabits-io/framework/storage/postgres — Postgres blob provider + HTTP serve handlers.
//
// Stores blobs in a self-creating `object_storage` table over raw parameterized
// SQL. The provider takes `db`: a `pg` `Pool` (optional peer; install `@types/pg`
// as a dev dependency for the type) or any structural `SqlExecutor` — an
// embedded PGlite instance, an RLS-scoped connection. It owns its table and
// never touches a host-application schema. Migration-managed setups can apply
// `objectStorageDdl()` and pass `autoCreateTable: false`.
export {
  createPostgresObjectStorageService,
  createPostgresObjectStorageUrlProvider,
  objectStorageDdl,
  poolExecutor,
  toExecutor,
} from './providers/postgres/PostgresObjectStorageService';
export type {
  SqlExecutor,
  SqlResult,
  TableInitializerOptions,
  PostgresObjectStorageService,
  PostgresObjectStorageConfig,
  PostgresObjectStorageUrlProvider,
  PostgresObjectStorageUrlProviderConfig,
} from './providers/postgres/PostgresObjectStorageService';

// Framework-agnostic HTTP handlers + key utilities for serving stored blobs.
export {
  getObjectData,
  createExpressHandler,
  createNitroHandler,
  createWebResponse,
  createGenericHandler,
  parseStoragePath,
  isValidObjectKey,
  sanitizeObjectKey,
  DEFAULT_CACHE_CONTROL,
} from './providers/postgres/postgres-handler';
export type {
  ServeObjectParams,
  ServeObjectResult,
  ServeObjectError,
  ServeHandlerOptions,
  ExpressLikeRequest,
  ExpressLikeResponse,
  NitroEvent,
  GenericRequest,
  GenericResponse,
} from './providers/postgres/postgres-handler';
