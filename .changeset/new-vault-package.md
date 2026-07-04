---
"@octabits-io/vault": minor
---

Add `@octabits-io/vault` — a boot-time HashiCorp Vault secret loader.
`loadVaultSecrets()` authenticates to Vault (Kubernetes SA-JWT or static
token), reads KV-v2 paths declared in a JSON manifest (`VAULT_SECRETS_MANIFEST`),
and hydrates `process.env` before config loads — a no-op when `VAULT_ADDR` is
unset. Plain `fetch`, no Vault SDK; `zod` is the only runtime peer. Also exports
the low-level `authenticate` / `readKvV2` client and `parseSecretManifest` /
`VAULT_SECRET_MANIFEST_SCHEMA`.
