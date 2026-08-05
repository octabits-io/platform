---
'@octabits-io/framework': minor
---

storage: per-object `visibility` option on `uploadObject`

`uploadObject` accepts an optional `visibility: 'public' | 'private'` that
overrides the provider's configured default ACL for that one object. The S3
provider maps `'private'` → ACL `private` and `'public'` → `public-read`;
omitted keeps the existing `defaultACL` behavior. Providers without
object-level access control (Postgres) ignore it.

Motivation: object ACLs grant access independently of any bucket policy, so
sensitive objects (e.g. encrypted mail attachments) uploaded under a
`public-read` default stayed world-readable even when the bucket policy
excluded their prefix.
