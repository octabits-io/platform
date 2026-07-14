// @octabits-io/framework/storage/postgres — Postgres blob provider + HTTP serve handlers.
//
// Stores blobs in a self-creating `object_storage` table on raw `pg`. Requires
// the optional peer dependency `pg` (install `@types/pg` as a dev dependency for
// the `Pool` type). The provider accepts a `pg` `Pool` — it owns its table and
// never touches a host-application schema. Migration-managed setups can apply
// `objectStorageDdl()` and pass `autoCreateTable: false`.
export {
  createPostgresObjectStorageService,
  createPostgresObjectStorageUrlProvider,
  objectStorageDdl,
} from './providers/postgres/PostgresObjectStorageService';
export type {
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
