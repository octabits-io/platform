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

## Examples

Every provider satisfies the same `ObjectStorageService` contract, so callers
are provider-agnostic — only the factory (and its config) differs.

### S3-compatible (`@octabits-io/storage/s3`)

```ts
import { createAWSObjectStorageService } from '@octabits-io/storage/s3';

const storage = createAWSObjectStorageService({
  bucket: 'app-blobs',
  publicEndpoint: 'https://cdn.example.com',
  region: 'eu-central',
  endpoint: 'https://<project>.your-objectstorage.com', // e.g. Hetzner Object Storage
  accessKeyId,
  secretAccessKey,
  logger,
});

await storage.uploadObject({ tenant: 't1', key: 'a/b.jpg', body: bytes });

const list = await storage.listObjects({ tenant: 't1', prefix: 'a/', includeHead: false });
if (list.ok) console.log(list.value.objects); // keys have the tenant prefix stripped

const url = storage.getPublicUrl({ tenant: 't1', key: 'a/b.jpg' });
// → https://cdn.example.com/tenant/t1/a/b.jpg
```

### Postgres blob store (`@octabits-io/storage/postgres`)

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPostgresObjectStorageService } from '@octabits-io/storage/postgres';

const db = drizzle(pool); // any standard drizzle-orm Postgres db

const storage = createPostgresObjectStorageService({
  drizzle: db, // typed as StorageDrizzle = PgDatabase<any, any, any>
  // build the public URL your app serves blobs from (see serve handler below)
  createPublicUrl: (tenant, key) => `https://app.example.com/api/storage/${tenant}/${key}`,
});

// The `object_storage` table is created on first use (CREATE TABLE IF NOT EXISTS).
await storage.uploadObject({ tenant: 't1', key: 'docs/f.pdf', body: bytes });

const obj = await storage.getObjectData({ tenant: 't1', key: 'docs/f.pdf' });
if (obj.ok) console.log(obj.value.contentType, obj.value.size);
```

Serve stored blobs over HTTP with a framework-agnostic handler (ETag / 304 /
`Cache-Control` included):

```ts
import { createWebResponse, sanitizeObjectKey } from '@octabits-io/storage/postgres';

// e.g. inside a Web-standard route handler
const key = sanitizeObjectKey(pathAfterTenant); // directory-traversal guard
return createWebResponse(storage, { tenant: 't1', key }, request.headers);
```

### Picsum (dev/mock, `@octabits-io/storage`)

```ts
import { createPicsumObjectStorageService } from '@octabits-io/storage';

// In-memory, no external SDK — deterministic picsum.photos URLs, ideal for dev/tests.
const storage = createPicsumObjectStorageService({
  baseUrl: 'https://picsum.photos',
  defaultDimensions: { width: 800, height: 600 },
});

await storage.uploadObject({
  tenant: 't1',
  key: 'hero.jpg',
  body: new Uint8Array([1, 2, 3]),
  metadata: { width: '1920', height: '1080' },
});

const url = storage.getPublicUrl({ tenant: 't1', key: 'hero.jpg' });
// → https://picsum.photos/seed/<key-hash>/1920/1080  (metadata dimensions win)
```

For a URL-only surface (no read/write), each provider also ships a lighter
factory — e.g. `createPicsumObjectStorageUrlProvider({ baseUrl })` exposing just
`getPublicUrl`.

## Testing

Use the picsum provider for a network-free in-memory store, or the
`ObjectFileServer` contract to stand in for the Postgres provider when testing
serve handlers.

## License

MIT
