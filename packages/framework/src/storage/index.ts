// ============================================================================
// @octabits-io/framework/storage — namespaced blob storage contract + providers
// ============================================================================
//
// The root entry is dependency-free: the `ObjectStorageService` contract and
// the data/error types. Vendor-backed providers live behind subpath exports so
// consumers only install and load the SDKs they actually use:
//
//   @octabits-io/framework/storage/s3        — S3-compatible provider (optional peer: @aws-sdk/client-s3)
//   @octabits-io/framework/storage/postgres  — Postgres blob provider + HTTP handlers (optional peer: pg)
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
