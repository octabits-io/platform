/**
 * Minimal HashiCorp Vault HTTP client.
 *
 * Plain `fetch` — no SDK dependency. Sufficient for boot-time KV-v2 reads
 * and the kubernetes/token auth flows used by the env-loader (PR 1) and
 * the transit master-key provider (PR 2).
 *
 * No long-lived state — callers authenticate once per boot and pass the
 * resulting token into subsequent reads.
 */

import { readFile } from 'node:fs/promises';

export type VaultAuthOptions =
  | { method: 'token'; token: string }
  | { method: 'k8s'; addr: string; namespace?: string; role: string; jwtPath: string };

/**
 * Authenticate against Vault and return a client token.
 *
 * For `method: 'token'` this is a no-op — the static token is returned as-is.
 * For `method: 'k8s'` the Kubernetes service-account JWT is read from
 * `jwtPath` and POSTed to `/v1/auth/kubernetes/login`.
 */
export async function authenticate(opts: VaultAuthOptions): Promise<string> {
  if (opts.method === 'token') {
    if (!opts.token) {
      throw new Error('Vault token auth selected but VAULT_TOKEN is empty');
    }
    return opts.token;
  }

  let jwt: string;
  try {
    jwt = await readFile(opts.jwtPath, 'utf8');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to read kubernetes service account token at ${opts.jwtPath}: ${reason}`);
  }
  const trimmedJwt = jwt.trim();

  const url = `${stripTrailingSlash(opts.addr)}/v1/auth/kubernetes/login`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.namespace) headers['X-Vault-Namespace'] = opts.namespace;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jwt: trimmedJwt, role: opts.role }),
  }).catch((cause: unknown) => {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Vault kubernetes login request failed: ${reason}`);
  });

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`Vault kubernetes login returned ${response.status}: ${body}`);
  }

  const json = (await response.json().catch(() => null)) as { auth?: { client_token?: string } } | null;
  const clientToken = json?.auth?.client_token;
  if (typeof clientToken !== 'string' || clientToken.length === 0) {
    throw new Error('Vault kubernetes login response missing auth.client_token');
  }
  return clientToken;
}

export interface ReadKvV2Options {
  addr: string;
  namespace?: string;
  token: string;
  /**
   * Vault KV-v2 path including the `data/` segment, e.g. `secret/data/reynt/api`.
   * The caller is responsible for the engine prefix and the `data/` segment —
   * this client passes the path through verbatim.
   */
  path: string;
}

/**
 * Read a KV-v2 secret and return its inner data map.
 *
 * KV-v2 wraps the user-set values under `data.data`; this helper unwraps that
 * one level so callers see a flat `Record<string, string>`.
 */
export async function readKvV2(options: ReadKvV2Options): Promise<Record<string, string>> {
  const url = `${stripTrailingSlash(options.addr)}/v1/${stripLeadingSlash(options.path)}`;
  const headers: Record<string, string> = { 'X-Vault-Token': options.token };
  if (options.namespace) headers['X-Vault-Namespace'] = options.namespace;

  const response = await fetch(url, { method: 'GET', headers }).catch((cause: unknown) => {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Vault KV read for ${options.path} failed: ${reason}`);
  });

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`Vault KV read for ${options.path} returned ${response.status}: ${body}`);
  }

  const json = (await response.json().catch(() => null)) as
    | { data?: { data?: Record<string, unknown> } }
    | null;
  const data = json?.data?.data;
  if (!data || typeof data !== 'object') {
    throw new Error(`Vault KV response for ${options.path} missing data.data`);
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') {
      throw new Error(`Vault KV value for ${options.path}#${key} is not a string`);
    }
    result[key] = value;
  }
  return result;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function stripLeadingSlash(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}
