---
"@octabits-io/storage": minor
---

Security and correctness fixes from review:

- **Path traversal enforced in the request path**: every serve handler (`createExpressHandler`, `createNitroHandler`, `createWebResponse`, `createGenericHandler`, via `getObjectData`) now rejects keys with traversal segments (plain or percent-encoded `..`), leading slashes, or empty keys with a 400 `invalid_key` error before touching storage; `parseStoragePath` percent-decodes and validates keys. The S3 provider additionally rejects `..`/leading-slash keys in `uploadObject`/`deleteObject`/`getObjectData` (`invalid_key`) as defense-in-depth against namespace-prefix escapes via CDN/browser URL normalization.
- **BEHAVIOR CHANGE (safety)**: `deleteObjectsByPrefix` now requires a non-empty `prefix` in BOTH providers and returns an `invalid_prefix` error otherwise. Previously a missing/empty prefix silently deleted the entire namespace (or, on S3 without a namespace, the entire bucket). Audit callers that relied on prefix-less bulk deletion.
- **S3 `listObjects` pagination fixed**: the returned `continuationToken` is now `NextContinuationToken` (was the request echo, so results were silently capped at 1000); new optional `continuationToken` and `maxKeys` inputs are plumbed to `ListObjectsV2` (additive; the Postgres provider still returns a single page).
- **S3 `uploadObject` now sets `ContentType`** from `metadata['content-type']`/`['contentType']` (fallback `application/octet-stream`), matching the Postgres provider — previously the content type landed only as `x-amz-meta-*` and objects served as the S3 default.
- Serve handlers always emit `X-Content-Type-Options: nosniff`; new optional `ServeHandlerOptions.contentDisposition` on every handler factory (default unset; recommended `'attachment'` for untrusted uploads — inline same-origin SVG/HTML is a stored-XSS vector).
- S3 `listObjects({ includeHead: true })` correctly applies the documented `application/octet-stream` / `{}` fallbacks when `HeadObject` fails (the failure shape was previously undetected, leaving `metadata`/`contentType` undefined) and uses the fetched `ContentLength` for `size`.
- S3 `NoSuchBucket` now maps to the dedicated `not_found_bucket` error key (was `not_found`).
- Postgres provider: new `autoCreateTable` option (default `true`, unchanged) to disable runtime DDL when the table is managed by migrations, and `advisoryLockId` to override the bootstrap advisory-lock id (default 123456789). With `autoCreateTable: true`, first-use reads require DDL privileges — now documented.
- `ObjectStorageError` gained the `invalid_key` and `invalid_prefix` keys; `ServeObjectError` gained `invalid_key`.
