# @octabits-io/storage

Namespaced blob storage: a small `ObjectStorageService` contract plus a set of
interchangeable providers. Pure blobs — every method takes an optional
`namespace`, and there is no listing/booking/domain coupling. Higher-level
concerns (SHA-256 audit rows, moderation status, CMS media) belong in an
asset/audit service that sits *above* these providers.

`namespace` is an optional logical partition for objects — a tenant id, an
environment name, or nothing at all. How it is realized is provider-specific (an
S3 key prefix, a Postgres column, an in-memory bucket). **Omit it** and you
address the *root* namespace, so single-tenant consumers never have to invent a
namespace value.

## Install

```bash
pnpm add @octabits-io/storage
# plus the SDK for each vendor provider you actually use:
pnpm add @aws-sdk/client-s3   # for @octabits-io/storage/s3
pnpm add drizzle-orm          # for @octabits-io/storage/postgres
```

`@octabits-io/foundation` (`Result`, `OctError`, `Logger`) is a runtime peer.
The vendor SDKs are **optional peer dependencies**: the root entry (`.`) is
dependency-free (contract + types only), and each provider lives behind its own
subpath so you only install and load the SDKs you use.

## The contract

```ts
import type { ObjectStorageService } from '@octabits-io/storage';

interface ObjectStorageService {
  readonly type?: string;
  getPublicUrl(p: { namespace?: string; key: string }): string;
  listObjects<T extends boolean>(p: { namespace?: string; prefix?: string; includeHead: T }): Promise<Result<ListObjectsResponse<T>, ObjectStorageError>>;
  uploadObject(p: { namespace?: string; key: string; metadata?: Record<string, string>; body: Uint8Array | ReadableStream<Uint8Array> }): Promise<Result<void, ObjectStorageError>>;
  deleteObject(p: { namespace?: string; key: string }): Promise<Result<void, ObjectStorageError>>;
  deleteObjectsByPrefix(p: { namespace?: string; prefix?: string }): Promise<Result<{ deleted: number }, ObjectStorageError>>;
  getObjectData(p: { namespace?: string; key: string }): Promise<Result<ObjectData, ObjectStorageError>>;
}
```

Every `namespace` is optional. Pass one to partition objects (multi-tenant); omit
it to use the single root namespace (single-tenant).

`ObjectStorageError` is an `OctErrorWithKey<'network_error' | 'not_found' | 'not_found_bucket' | 'access_denied' | 'internal_error'>`.

## Providers

| Factory | Import from | SDK peer | Notes |
| --- | --- | --- | --- |
| `createAWSObjectStorageService(config)` | `@octabits-io/storage/s3` | `@aws-sdk/client-s3` | `type: 's3'`. **S3-compatible**, not AWS-bound — explicit `endpoint` + `forcePathStyle` (production: Hetzner Object Storage, EU). Keys are namespace-prefixed (`<namespace>/<key>` by default, unprefixed when the namespace is omitted); customize the prefix with `namespacePrefix`. Transient failures are retried with backoff. |
| `createPostgresObjectStorageService(config)` | `@octabits-io/storage/postgres` | `drizzle-orm` | `type: 'postgres'`. Stores blobs in a self-creating `object_storage` table. Accepts any standard drizzle-orm Postgres db (`StorageDrizzle = PgDatabase<any, any, any>`). |

Each also ships a lighter URL-only provider factory
(`createAWSObjectStorageUrlProvider` / `createPostgresObjectStorageUrlProvider`)
exposing just `getPublicUrl`.

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

await storage.uploadObject({ namespace: 't1', key: 'a/b.jpg', body: bytes });

const list = await storage.listObjects({ namespace: 't1', prefix: 'a/', includeHead: false });
if (list.ok) console.log(list.value.objects); // keys have the namespace prefix stripped

const url = storage.getPublicUrl({ namespace: 't1', key: 'a/b.jpg' });
// → https://cdn.example.com/t1/a/b.jpg

// Single-tenant? Omit the namespace entirely — objects live in the root namespace,
// keys are stored unprefixed, and getPublicUrl returns https://cdn.example.com/a/b.jpg
await storage.uploadObject({ key: 'a/b.jpg', body: bytes });

// Migrating off the previous `tenant/<ns>/` layout? Reproduce it with namespacePrefix:
const legacy = createAWSObjectStorageService({
  /* ...config... */
  namespacePrefix: (ns) => `tenant/${ns}/`,
});
legacy.getPublicUrl({ namespace: 't1', key: 'a/b.jpg' });
// → https://cdn.example.com/tenant/t1/a/b.jpg
```

`namespacePrefix` is available on both `AWSClientObjectStorageConfig` and
`AWSObjectStorageUrlProviderConfig`.

### Postgres blob store (`@octabits-io/storage/postgres`)

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPostgresObjectStorageService } from '@octabits-io/storage/postgres';

const db = drizzle(pool); // any standard drizzle-orm Postgres db

const storage = createPostgresObjectStorageService({
  drizzle: db, // typed as StorageDrizzle = PgDatabase<any, any, any>
  // build the public URL your app serves blobs from (see serve handler below).
  // `namespace` is `string | undefined` — undefined = root namespace (stored as '').
  createPublicUrl: (namespace, key) =>
    `https://app.example.com/api/storage/${namespace ?? '_'}/${key}`,
});

// The `object_storage` table is created on first use (CREATE TABLE IF NOT EXISTS);
// a legacy `tenant_id` column is migrated to `namespace` automatically.
await storage.uploadObject({ namespace: 't1', key: 'docs/f.pdf', body: bytes });

const obj = await storage.getObjectData({ namespace: 't1', key: 'docs/f.pdf' });
if (obj.ok) console.log(obj.value.contentType, obj.value.size);

// Single-tenant: omit the namespace (stored under the '' root namespace).
await storage.uploadObject({ key: 'docs/f.pdf', body: bytes });
```

Serve stored blobs over HTTP with a framework-agnostic handler (ETag / 304 /
`Cache-Control` included):

```ts
import { createWebResponse, sanitizeObjectKey } from '@octabits-io/storage/postgres';

// e.g. inside a Web-standard route handler
const key = sanitizeObjectKey(pathAfterPrefix); // directory-traversal guard
return createWebResponse(storage, { namespace: 't1', key }, request.headers);
// single-tenant: return createWebResponse(storage, { key }, request.headers);
```

## Testing

The `ObjectStorageService` contract is small enough to fake with a `Map`-backed
in-memory implementation in your test utilities, and the `ObjectFileServer`
contract can stand in for the Postgres provider when testing serve handlers.

## License

MIT
