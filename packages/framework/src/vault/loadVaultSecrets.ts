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
 *      mapping — but only if the env var is currently unset **or empty** so
 *      that local overrides and break-glass values in `.env` always win.
 *      (Empty strings count as unset: `FOO=` in an env file is a common
 *      accident and never a meaningful secret override.)
 *
 * Any failure (auth, network, timeout, missing key, malformed manifest)
 * throws synchronously. The entrypoint's `await loadVaultSecrets()`
 * propagates the error and the process refuses to start. This is
 * intentional — a silent fallback to env vars where Vault is meant to be
 * the source of truth would mask configuration bugs.
 */

import { readFile } from 'node:fs/promises';
import { authenticate, readKvV2, type VaultAuthOptions } from './vaultClient.ts';
import { parseSecretManifest } from './secretManifest.ts';

const DEFAULT_K8S_JWT_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

export async function loadVaultSecrets(): Promise<void> {
  const addr = process.env.VAULT_ADDR;
  if (!addr) return;

  const manifest = parseSecretManifest(process.env.VAULT_SECRETS_MANIFEST);
  if (manifest.length === 0) return;

  const namespace = process.env.VAULT_NAMESPACE || undefined;
  const timeoutMs = resolveTimeoutMs();
  const caCertPem = await resolveCaCertPem(addr);
  const authOptions = resolveAuthOptions(addr, namespace, timeoutMs, caCertPem);
  const token = await authenticate(authOptions);

  for (const entry of manifest) {
    const data = await readKvV2({ addr, namespace, token, path: entry.path, timeoutMs, caCertPem });
    for (const [vaultKey, envVar] of Object.entries(entry.map)) {
      const value = data[vaultKey];
      if (value === undefined) {
        throw new Error(`Vault path ${entry.path} is missing key "${vaultKey}" required by VAULT_SECRETS_MANIFEST`);
      }
      // Empty string counts as unset — a blank `FOO=` line in an env file
      // must not shadow the Vault value. Non-empty values are never clobbered.
      const current = process.env[envVar];
      if (current === undefined || current === '') {
        process.env[envVar] = value;
      }
    }
  }
}

function resolveTimeoutMs(): number | undefined {
  const raw = process.env.VAULT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`VAULT_TIMEOUT_MS must be a positive number of milliseconds, got "${raw}"`);
  }
  return parsed;
}

/**
 * `VAULT_CACERT` follows the Vault CLI convention: a *path* to a PEM-encoded
 * CA certificate to trust for the Vault server's TLS certificate (e.g. an
 * in-cluster private CA mounted into the pod). Returned as file contents so
 * the client never touches the filesystem per request.
 */
async function resolveCaCertPem(addr: string): Promise<string | undefined> {
  const caPath = process.env.VAULT_CACERT?.trim();
  if (!caPath) return undefined;

  if (!addr.toLowerCase().startsWith('https://')) {
    throw new Error(
      `VAULT_CACERT is set but VAULT_ADDR (${addr}) is not https — a CA certificate only applies to TLS connections`,
    );
  }

  let pem: string;
  try {
    pem = await readFile(caPath, 'utf8');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to read VAULT_CACERT at ${caPath}: ${reason}`);
  }
  if (!pem.trim()) {
    throw new Error(`VAULT_CACERT file at ${caPath} is empty`);
  }
  return pem;
}

function resolveAuthOptions(
  addr: string,
  namespace: string | undefined,
  timeoutMs: number | undefined,
  caCertPem: string | undefined,
): VaultAuthOptions {
  const rawMethod = process.env.VAULT_AUTH_METHOD;
  // Empty/whitespace-only counts as unset (fall back to inference).
  const explicit = rawMethod?.trim().toLowerCase() || undefined;
  if (explicit !== undefined && explicit !== 'token' && explicit !== 'k8s') {
    throw new Error(`unknown VAULT_AUTH_METHOD "${rawMethod}" (expected "token" or "k8s")`);
  }

  const role = process.env.VAULT_K8S_ROLE;
  const method: 'token' | 'k8s' = explicit ?? (role ? 'k8s' : 'token');

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
  const mount = process.env.VAULT_K8S_MOUNT || undefined;
  return { method: 'k8s', addr, namespace, role, jwtPath, mount, timeoutMs, caCertPem };
}
