// ============================================================================
// @octabits-io/storage — namespaced blob storage contract + providers
// ============================================================================
//
// The root entry is dependency-light: the `ObjectStorageService` contract, the
// data/error types, and the picsum provider (an in-memory dev/mock store with
// no external SDKs). Vendor-backed providers live behind subpath exports so
// consumers only install and load the SDKs they actually use:
//
//   @octabits-io/storage/s3        — S3-compatible provider (optional peer: @aws-sdk/client-s3)
//   @octabits-io/storage/postgres  — Postgres blob provider + HTTP handlers (optional peer: drizzle-orm)
//
// All methods accept an optional `namespace` that partitions objects (key
// prefix on S3, column on Postgres). Multi-tenant consumers pass a tenant id
// as the namespace; single-tenant consumers simply omit it. There is no other
// domain coupling.

// --- Base contract ---------------------------------------------------------
export type {
  ObjectStorageService,
  ObjectStorageUrlProvider,
  ObjectFileServer,
} from './base/interfaces';
export type {
  StorageObject,
  StorageObjectWithHead,
  ListObjectsResponse,
  ObjectData,
} from './base/types';
export type { ObjectStorageError } from './base/errors';

// --- Picsum provider (dev/mock, in-memory, dependency-free) ----------------
export {
  createPicsumObjectStorageService,
  createPicsumObjectStorageUrlProvider,
} from './providers/picsum/PicsumObjectStorageService';
export type {
  PicsumObjectStorageService,
  PicsumObjectStorageServiceConfig,
  PicsumObjectStorageUrlProvider,
  PicsumObjectStorageUrlProviderConfig,
} from './providers/picsum/PicsumObjectStorageService';
