/**
 * Boot-time hydration of `process.env` from HashiCorp Vault.
 *
 * Runs *before* config loading in every API/worker entrypoint. When
 * `VAULT_ADDR` is unset (or the manifest is empty) this is a no-op and the
 * process behaves identically to today — secrets continue to come from
 * the runtime's own `.env` loading.
 *
 * When configured, the loader:
 *   1. Authenticates against Vault (kubernetes or static-token).
 *   2. Reads each KV-v2 path declared in the manifest.
 *   3. Sets `process.env[envVar] = value` for each `(vaultKey -> envVar)`
 *      mapping — but only if the env var is currently `undefined` so that
 *      local overrides and break-glass values in `.env` always win.
 *
 * Any failure (auth, network, missing key, malformed manifest) throws
 * synchronously. The entrypoint's `await loadVaultSecrets()` propagates
 * the error and the process refuses to start. This is intentional — a
 * silent fallback to env vars where Vault is meant to be the source of
 * truth would mask configuration bugs.
 */

import { authenticate, readKvV2, type VaultAuthOptions } from './vaultClient';
import { parseSecretManifest } from './secretManifest';

const DEFAULT_K8S_JWT_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

export async function loadVaultSecrets(): Promise<void> {
  const addr = process.env.VAULT_ADDR;
  if (!addr) return;

  const manifest = parseSecretManifest(process.env.VAULT_SECRETS_MANIFEST);
  if (manifest.length === 0) return;

  const namespace = process.env.VAULT_NAMESPACE || undefined;
  const authOptions = resolveAuthOptions(addr, namespace);
  const token = await authenticate(authOptions);

  for (const entry of manifest) {
    const data = await readKvV2({ addr, namespace, token, path: entry.path });
    for (const [vaultKey, envVar] of Object.entries(entry.map)) {
      const value = data[vaultKey];
      if (value === undefined) {
        throw new Error(`Vault path ${entry.path} is missing key "${vaultKey}" required by VAULT_SECRETS_MANIFEST`);
      }
      if (process.env[envVar] === undefined) {
        process.env[envVar] = value;
      }
    }
  }
}

function resolveAuthOptions(addr: string, namespace: string | undefined): VaultAuthOptions {
  const explicit = process.env.VAULT_AUTH_METHOD?.toLowerCase();
  const role = process.env.VAULT_K8S_ROLE;
  const method: 'token' | 'k8s' = explicit === 'token' || explicit === 'k8s'
    ? explicit
    : role
      ? 'k8s'
      : 'token';

  if (method === 'token') {
    const token = process.env.VAULT_TOKEN;
    if (!token) {
      throw new Error('VAULT_AUTH_METHOD=token but VAULT_TOKEN is not set');
    }
    return { method: 'token', token };
  }

  if (!role) {
    throw new Error('VAULT_AUTH_METHOD=k8s but VAULT_K8S_ROLE is not set');
  }
  const jwtPath = process.env.VAULT_K8S_JWT_PATH || DEFAULT_K8S_JWT_PATH;
  return { method: 'k8s', addr, namespace, role, jwtPath };
}
