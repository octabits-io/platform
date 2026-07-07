// @octabits-io/storage/postgres — Postgres blob provider + HTTP serve handlers.
//
// Stores blobs in a self-creating `object_storage` table. Requires the optional
// peer dependency `drizzle-orm`. The provider accepts any standard drizzle-orm
// Postgres database (`StorageDrizzle` = `PgDatabase<any, any, any>`) — it is not
// bound to any host application's augmented Drizzle instance.
export {
  createPostgresObjectStorageService,
  createPostgresObjectStorageUrlProvider,
  objectStorageTable,
} from './providers/postgres/PostgresObjectStorageService';
export type {
  StorageDrizzle,
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
