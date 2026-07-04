# @octabits-io/vault

Boot-time HashiCorp Vault secret loader. Authenticate to Vault (Kubernetes
service-account JWT or static token), read KV-v2 paths declared in a JSON
manifest, and hydrate `process.env` **before** your config loads.

Plain `fetch` — no Vault SDK dependency. The only runtime peer is `zod`
(manifest validation).

## Install

```bash
pnpm add @octabits-io/vault zod
```

## Usage

Call `loadVaultSecrets()` at the very top of every API/worker entrypoint,
before you read any config:

```ts
import { loadVaultSecrets } from '@octabits-io/vault';

await loadVaultSecrets(); // hydrates process.env from Vault (no-op when VAULT_ADDR unset)

const { loadConfig } = await import('./config');
const config = loadConfig();
```

When `VAULT_ADDR` is unset (or the manifest is empty) this is a **no-op** and
the process behaves identically to plain `.env` loading. When configured, the
loader:

1. Authenticates against Vault (kubernetes or static-token).
2. Reads each KV-v2 path declared in the manifest.
3. Sets `process.env[envVar] = value` for each `(vaultKey → envVar)` mapping —
   but only if the env var is currently `undefined`, so local overrides and
   break-glass values in `.env` always win.

Any failure (auth, network, missing key, malformed manifest) throws
synchronously so the process refuses to start — a silent fallback to env vars
where Vault is meant to be the source of truth would mask configuration bugs.

## Environment variables

| Var | Purpose |
| --- | --- |
| `VAULT_ADDR` | Vault base URL. **Unset → loader is a no-op.** |
| `VAULT_SECRETS_MANIFEST` | JSON array of `(path → env-var map)` bindings. Empty/unset → no-op. |
| `VAULT_AUTH_METHOD` | `token` or `k8s`. Defaults to `k8s` when `VAULT_K8S_ROLE` is set, else `token`. |
| `VAULT_TOKEN` | Static token (for `token` auth). |
| `VAULT_K8S_ROLE` | Vault Kubernetes auth role (for `k8s` auth). |
| `VAULT_K8S_JWT_PATH` | Service-account JWT path (default `/var/run/secrets/kubernetes.io/serviceaccount/token`). |
| `VAULT_NAMESPACE` | Optional Vault Enterprise namespace (`X-Vault-Namespace`). |

## Manifest format

`VAULT_SECRETS_MANIFEST` is a JSON-encoded list of bindings. Each entry maps
Vault keys at a single KV-v2 path to the `process.env` variables that should
receive their values:

```json
[
  {
    "path": "secret/data/app/api",
    "map": { "db_url": "DATABASE_URL", "stripe": "STRIPE_SECRET_KEY" }
  }
]
```

The `path` includes the KV-v2 `data/` segment verbatim — the client passes it
through as `/v1/<path>`.

## API

- `loadVaultSecrets(): Promise<void>` — the boot-time entrypoint above.
- `authenticate(opts): Promise<string>` — low-level: return a client token for
  `{ method: 'token' }` or `{ method: 'k8s' }`.
- `readKvV2(opts): Promise<Record<string, string>>` — low-level: read a KV-v2
  path and return its unwrapped `data.data` map.
- `parseSecretManifest(raw): VaultSecretManifest` — parse/validate the manifest
  env var (returns `[]` for unset/empty).
- `VAULT_SECRET_MANIFEST_SCHEMA` — the Zod schema.
- Types: `VaultAuthOptions`, `ReadKvV2Options`, `VaultSecretManifest`,
  `VaultSecretManifestEntry`.

## License

MIT
