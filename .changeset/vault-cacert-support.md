---
"@octabits-io/framework": minor
---

feat(vault): `VAULT_CACERT` support for private CAs

The vault client and `loadVaultSecrets` now accept a custom CA certificate for
Vault servers behind a private CA (e.g. an in-cluster `vault-ca`):

- `loadVaultSecrets` reads `VAULT_CACERT` (Vault CLI convention: a *path* to a
  PEM-encoded CA certificate) and fails loud on an unreadable/empty file or a
  non-`https` `VAULT_ADDR`.
- `authenticate` (k8s method) and `readKvV2` gain an optional `caCertPem`
  option (PEM contents).
- When a CA is set, requests are dispatched via `node:https` instead of
  `fetch` — the only dependency-free mechanism that honors a custom CA on both
  Node and Bun. Behavior without `VAULT_CACERT` is unchanged.
