# @octabits-io/framework/storage

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
pnpm add @octabits-io/framework/storage
# plus the SDK for each vendor provider you actually use:
pnpm add @aws-sdk/client-s3   # for @octabits-io/framework/storage/s3
pnpm add pg                   # for @octabits-io/framework/storage/postgres
pnpm add -D @types/pg         # Pool type for the Postgres provider
```

`@octabits-io/framework` (`Result`, `OctError`, `Logger`) is a runtime peer.
The vendor SDKs are **optional peer dependencies**: the root entry (`.`) is
dependency-free (contract + types only), and each provider lives behind its own
subpath so you only install and load the SDKs you use.

## The contract

```ts
import type { ObjectStorageService } from '@octabits-io/framework/storage';

interface ObjectStorageService {
  readonly type?: string;
  getPublicUrl(p: { namespace?: string; key: string }): string;
  listObjects<T extends boolean>(p: { namespace?: string; prefix?: string; includeHead: T; continuationToken?: string; maxKeys?: number }): Promise<Result<ListObjectsResponse<T>, ObjectStorageError>>;
  uploadObject(p: { namespace?: string; key: string; metadata?: Record<string, string>; body: Uint8Array | ReadableStream<Uint8Array> }): Promise<Result<void, ObjectStorageError>>;
  deleteObject(p: { namespace?: string; key: string }): Promise<Result<void, ObjectStorageError>>;
  deleteObjectsByPrefix(p: { namespace?: string; prefix?: string }): Promise<Result<{ deleted: number }, ObjectStorageError>>;
  getObjectData(p: { namespace?: string; key: string }): Promise<Result<ObjectData, ObjectStorageError>>;
}
```

Every `namespace` is optional. Pass one to partition objects (multi-tenant); omit
it to use the single root namespace (single-tenant).

`listObjects` pages: pass the `continuationToken` from
`ListObjectsResponse.continuationToken` to fetch the next page (S3 pages at up
to 1000 objects; the Postgres provider returns everything in one page).

`deleteObjectsByPrefix` requires a **non-empty** `prefix` — a missing/empty
prefix would wipe the whole namespace (or bucket) and yields an
`invalid_prefix` error instead.

`ObjectStorageError` is an `OctErrorWithKey<'network_error' | 'not_found' | 'not_found_bucket' | 'access_denied' | 'invalid_key' | 'invalid_prefix' | 'internal_error'>`.

## Providers

| Factory | Import from | SDK peer | Notes |
| --- | --- | --- | --- |
| `createAWSObjectStorageService(config)` | `@octabits-io/framework/storage/s3` | `@aws-sdk/client-s3` | `type: 's3'`. **S3-compatible**, not AWS-bound — explicit `endpoint` + `forcePathStyle` (production: Hetzner Object Storage, EU). Keys are namespace-prefixed (`<namespace>/<key>` by default, unprefixed when the namespace is omitted); customize the prefix with `namespacePrefix`. Transient failures are retried with backoff. |
| `createPostgresObjectStorageService(config)` | `@octabits-io/framework/storage/postgres` | `pg` | `type: 'postgres'`. Stores blobs in a self-creating `object_storage` table on raw `pg`. Accepts a `pg` `Pool`. Migration-managed setups apply `objectStorageDdl()` and pass `autoCreateTable: false`. |

Each also ships a lighter URL-only provider factory
(`createAWSObjectStorageUrlProvider` / `createPostgresObjectStorageUrlProvider`)
exposing just `getPublicUrl`.

### Serving Postgres-stored blobs over HTTP

`@octabits-io/framework/storage/postgres` also exports framework-agnostic serve handlers
built on the `ObjectFileServer` contract — `createGenericHandler`,
`createExpressHandler`, `createNitroHandler`, and `createWebResponse` — plus the
`parseStoragePath` / `isValidObjectKey` / `sanitizeObjectKey` key utilities.
Every handler validates the request key before touching storage (traversal
segments — plain or percent-encoded — leading slashes, and empty keys are
rejected with 400), emits ETag / `Last-Modified` / `Cache-Control` /
`X-Content-Type-Options: nosniff` headers, and honors `If-None-Match` (304).
An optional `ServeHandlerOptions.contentDisposition` (e.g. `'attachment'`) is
available on every handler factory — strongly recommended when serving
user-uploaded SVG/HTML from your app's origin, since inline rendering of
untrusted markup enables stored XSS.

## Examples

Every provider satisfies the same `ObjectStorageService` contract, so callers
are provider-agnostic — only the factory (and its config) differs.

### S3-compatible (`@octabits-io/framework/storage/s3`)

```ts
import { createAWSObjectStorageService } from '@octabits-io/framework/storage/s3';

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

### Postgres blob store (`@octabits-io/framework/storage/postgres`)

```ts
import { Pool } from 'pg'; // install `pg` and, as a dev dep, `@types/pg`
import { createPostgresObjectStorageService } from '@octabits-io/framework/storage/postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const storage = createPostgresObjectStorageService({
  pool, // a pg Pool
  // build the public URL your app serves blobs from (see serve handler below).
  // `namespace` is `string | undefined` — undefined = root namespace (stored as '').
  createPublicUrl: (namespace, key) =>
    `https://app.example.com/api/storage/${namespace ?? '_'}/${key}`,
});

// The `object_storage` table is created on first use (CREATE TABLE IF NOT EXISTS);
// a legacy `tenant_id` column is migrated to `namespace` automatically, and the
// (namespace, key) unique constraint that uploads upsert on is added.
// NOTE: with this default (`autoCreateTable: true`) the connected role needs
// DDL privileges — even a plain read can trigger the bootstrap. Pass
// `autoCreateTable: false` when the table is managed by migrations (see
// `objectStorageDdl()` below), and `advisoryLockId` to change the bootstrap's
// pg_advisory_xact_lock id (default 123456789) if it collides with one of yours.
await storage.uploadObject({ namespace: 't1', key: 'docs/f.pdf', body: bytes });

const obj = await storage.getObjectData({ namespace: 't1', key: 'docs/f.pdf' });
if (obj.ok) console.log(obj.value.contentType, obj.value.size);
// obj.value.lastModified is an ISO 8601 string (e.g. '2026-01-02T03:04:05.000Z').

// Single-tenant: omit the namespace (stored under the '' root namespace).
await storage.uploadObject({ key: 'docs/f.pdf', body: bytes });
```

#### Migration-managed schema (`objectStorageDdl()`)

Prefer to own the schema in your migrations? Apply `objectStorageDdl()` once and
pass `autoCreateTable: false` so the provider never issues DDL at runtime:

```ts
import { objectStorageDdl } from '@octabits-io/framework/storage/postgres';

await pool.query(objectStorageDdl()); // CREATE TABLE + indexes + unique constraint

const storage = createPostgresObjectStorageService({
  pool,
  createPublicUrl,
  autoCreateTable: false,
});
```

`objectStorageDdl()` emits the `object_storage` table, both indexes, and the
`object_storage_namespace_key_unique` constraint on `(namespace, key)`. That
constraint is **required**: `uploadObject` is a single `INSERT … ON CONFLICT
(namespace, key) DO UPDATE` upsert, so a table without it (e.g. a legacy table
plus `autoCreateTable: false`) fails uploads with a pointed `internal_error`.
The default bootstrap adds the constraint automatically; the legacy
`tenant_id → namespace` rename runs only in that bootstrap, not in
`objectStorageDdl()`.

Serve stored blobs over HTTP with a framework-agnostic handler (ETag / 304 /
`Cache-Control` included):

```ts
import { createWebResponse } from '@octabits-io/framework/storage/postgres';

// e.g. inside a Web-standard route handler. Traversal / invalid keys are
// rejected with 400 by the handler itself; `sanitizeObjectKey` remains
// available if you prefer normalizing instead of rejecting.
return createWebResponse(storage, { namespace: 't1', key: pathAfterPrefix }, request.headers);
// single-tenant: return createWebResponse(storage, { key }, request.headers);
// untrusted uploads: pass { contentDisposition: 'attachment' } as the 4th arg
```

## Testing

The `ObjectStorageService` contract is small enough to fake with a `Map`-backed
in-memory implementation in your test utilities, and the `ObjectFileServer`
contract can stand in for the Postgres provider when testing serve handlers.

## License

MIT
