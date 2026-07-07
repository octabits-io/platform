# @octabits-io/vault

## 0.3.0

### Minor Changes

- [`513571d`](https://github.com/octabits-io/platform/commit/513571d069bac7ebd52234fcaf154aa8b1e8e315) - Review fixes: request timeouts and hardened env handling.

  - All Vault HTTP calls (kubernetes login and KV reads) now carry a timeout (default 10 s, override via `VAULT_TIMEOUT_MS` or the new `timeoutMs` option on `authenticate`/`readKvV2`); a hung Vault maps to a clear boot error instead of blocking startup forever.
  - New `VAULT_K8S_MOUNT` env option (and `mount` auth option) for the kubernetes auth mount path (default `kubernetes`).
  - Unknown `VAULT_AUTH_METHOD` values now throw (`expected "token" or "k8s"`) instead of silently falling back to inference.
  - `VAULT_TOKEN` is trimmed like the k8s JWT; empty-string target env vars count as unset for hydration (non-empty values are still never clobbered); number/boolean KV scalars are coerced via `String()` while objects/arrays/null still fail loud.
  - Internal imports use `.ts` extensions per repo convention; README documents the TLS assumption (plain `http://` only for in-cluster/agent-sidecar traffic).

## 0.2.0

### Minor Changes

- [`75c2fac`](https://github.com/octabits-io/platform/commit/75c2fac0e6e8080d45ed03e22aa4639856cc5ce9) - Add `@octabits-io/vault` — a boot-time HashiCorp Vault secret loader.
  `loadVaultSecrets()` authenticates to Vault (Kubernetes SA-JWT or static
  token), reads KV-v2 paths declared in a JSON manifest (`VAULT_SECRETS_MANIFEST`),
  and hydrates `process.env` before config loads — a no-op when `VAULT_ADDR` is
  unset. Plain `fetch`, no Vault SDK; `zod` is the only runtime peer. Also exports
  the low-level `authenticate` / `readKvV2` client and `parseSecretManifest` /
  `VAULT_SECRET_MANIFEST_SCHEMA`.
