---
"@octabits-io/pii": minor
---

Export the high-level PII helpers (`encryptPiiString` / `decryptPiiString`,
`encryptPiiJson` / `decryptPiiJson`, `encryptPiiBytes` / `decryptPiiBytes`) from
the package entrypoint. The `createPiiEncryptionService` /
`createPiiEncryptionOnlyService` factories are sugar over these; consumers that
resolve keys per call (e.g. a per-tenant wrapper) can now call the stateless
helpers directly with a `recipient` / `identity` instead of constructing a
service per operation.
