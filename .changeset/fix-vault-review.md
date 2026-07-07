---
'@octabits-io/vault': minor
---

Review fixes: request timeouts and hardened env handling.

- All Vault HTTP calls (kubernetes login and KV reads) now carry a timeout (default 10 s, override via `VAULT_TIMEOUT_MS` or the new `timeoutMs` option on `authenticate`/`readKvV2`); a hung Vault maps to a clear boot error instead of blocking startup forever.
- New `VAULT_K8S_MOUNT` env option (and `mount` auth option) for the kubernetes auth mount path (default `kubernetes`).
- Unknown `VAULT_AUTH_METHOD` values now throw (`expected "token" or "k8s"`) instead of silently falling back to inference.
- `VAULT_TOKEN` is trimmed like the k8s JWT; empty-string target env vars count as unset for hydration (non-empty values are still never clobbered); number/boolean KV scalars are coerced via `String()` while objects/arrays/null still fail loud.
- Internal imports use `.ts` extensions per repo convention; README documents the TLS assumption (plain `http://` only for in-cluster/agent-sidecar traffic).
