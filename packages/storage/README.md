# @octabits-io/storage

Tenant-namespaced blob storage: a small `ObjectStorageService` contract plus a
set of interchangeable providers. Pure blobs — every method takes `tenant` as a
parameter, and there is no listing/booking/domain coupling. Higher-level
concerns (SHA-256 audit rows, moderation status, CMS media) belong in an
asset/audit service that sits *above* these providers.

## Install

```bash
pnpm add @octabits-io/storage
# plus the SDK for each vendor provider you actually use:
pnpm add @aws-sdk/client-s3   # for @octabits-io/storage/s3
pnpm add drizzle-orm          # for @octabits-io/storage/postgres
```

`@octabits-io/foundation` (`Result`, `OctError`, `Logger`) is a runtime peer.
The vendor SDKs are **optional peer dependencies**: the root entry (`.`) is
dependency-light (contract + picsum dev/mock provider), and each vendor-backed
provider lives behind its own subpath so you only install and load the SDKs you
use.

## The contract

```ts
import type { ObjectStorageService } from '@octabits-io/storage';

interface ObjectStorageService {
  readonly type?: string;
  getPublicUrl(p: { tenant: string; key: string }): string;
  listObjects<T extends boolean>(p: { tenant: string; prefix?: string; includeHead: T }): Promise<Result<ListObjectsResponse<T>, ObjectStorageError>>;
  uploadObject(p: { tenant: string; key: string; metadata?: Record<string, string>; body: Uint8Array | ReadableStream<Uint8Array> }): Promise<Result<void, ObjectStorageError>>;
  deleteObject(p: { tenant: string; key: string }): Promise<Result<void, ObjectStorageError>>;
  deleteObjectsByPrefix(p: { tenant: string; prefix?: string }): Promise<Result<{ deleted: number }, ObjectStorageError>>;
  getObjectData(p: { tenant: string; key: string }): Promise<Result<ObjectData, ObjectStorageError>>;
}
```

`ObjectStorageError` is an `OctErrorWithKey<'network_error' | 'not_found' | 'not_found_bucket' | 'access_denied' | 'internal_error'>`.

## Providers

| Factory | Import from | SDK peer | Notes |
| --- | --- | --- | --- |
| `createAWSObjectStorageService(config)` | `@octabits-io/storage/s3` | `@aws-sdk/client-s3` | `type: 's3'`. **S3-compatible**, not AWS-bound — explicit `endpoint` + `forcePathStyle` (production: Hetzner Object Storage, EU). Keys are tenant-prefixed (`tenant/<tenant>/<key>`); transient failures are retried with backoff. |
| `createPostgresObjectStorageService(config)` | `@octabits-io/storage/postgres` | `drizzle-orm` | `type: 'postgres'`. Stores blobs in a self-creating `object_storage` table. Accepts any standard drizzle-orm Postgres db (`StorageDrizzle = PgDatabase<any, any, any>`). |
| `createPicsumObjectStorageService(config)` | `@octabits-io/storage` | — | `type: 'picsum'`. In-memory dev/mock store returning deterministic picsum.photos URLs. |

Each also ships a lighter URL-only provider factory
(`createAWSObjectStorageUrlProvider` / `createPostgresObjectStorageUrlProvider` /
`createPicsumObjectStorageUrlProvider`) exposing just `getPublicUrl`.

### Serving Postgres-stored blobs over HTTP

`@octabits-io/storage/postgres` also exports framework-agnostic serve handlers
built on the `ObjectFileServer` contract — `createGenericHandler`,
`createExpressHandler`, `createNitroHandler`, and `createWebResponse` — plus the
`parseStoragePath` / `isValidObjectKey` / `sanitizeObjectKey` key utilities
(directory-traversal guards included). They emit ETag / `Last-Modified` /
`Cache-Control` headers and honor `If-None-Match` (304).

## Example

```ts
import { createAWSObjectStorageService } from '@octabits-io/storage/s3';

const storage = createAWSObjectStorageService({
  bucket: 'app-blobs',
  publicEndpoint: 'https://cdn.example.com',
  region: 'eu-central',
  endpoint: 'https://<project>.your-objectstorage.com',
  accessKeyId,
  secretAccessKey,
  logger,
});

await storage.uploadObject({ tenant: 't1', key: 'a/b.jpg', body: bytes });
const url = storage.getPublicUrl({ tenant: 't1', key: 'a/b.jpg' });
```

## Testing

Use the picsum provider for a network-free in-memory store, or the
`ObjectFileServer` contract to stand in for the Postgres provider when testing
serve handlers.

## License

MIT
