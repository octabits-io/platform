---
'@octabits-io/pii': minor
---

`createEnvVarMasterKeyProvider` now throws at startup if the master key source is shorter than 32 characters (exported as `MIN_MASTER_KEY_SOURCE_LENGTH`). HKDF does no password stretching, so a short or human-chosen source undermines the derived AES-256 key; the provider now fails fast on misconfiguration instead of silently encrypting under weak key material. Docs updated with generation guidance (`openssl rand -base64 32`). Also fixed a Node `DEP0182` deprecation warning by passing `authTagLength` to `createDecipheriv` in `decryptSymmetric` (no behavioral change).
