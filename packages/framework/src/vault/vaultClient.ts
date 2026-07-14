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

/** Default per-request timeout for Vault HTTP calls (login and KV reads). */
export const DEFAULT_VAULT_TIMEOUT_MS = 10_000;

export type VaultAuthOptions =
  | { method: 'token'; token: string }
  | {
      method: 'k8s';
      addr: string;
      namespace?: string;
      role: string;
      jwtPath: string;
      /** Kubernetes auth mount path (`/v1/auth/<mount>/login`). @default 'kubernetes' */
      mount?: string;
      /** Request timeout in milliseconds. @default 10_000 */
      timeoutMs?: number;
    };

/**
 * Authenticate against Vault and return a client token.
 *
 * For `method: 'token'` this is a no-op — the static token is trimmed and
 * returned as-is.
 * For `method: 'k8s'` the Kubernetes service-account JWT is read from
 * `jwtPath` and POSTed to `/v1/auth/<mount>/login` (mount defaults to
 * `kubernetes`).
 */
export async function authenticate(opts: VaultAuthOptions): Promise<string> {
  if (opts.method === 'token') {
    // Trim like the k8s JWT — tokens from files/env often carry a trailing newline.
    const token = opts.token.trim();
    if (!token) {
      throw new Error('Vault token auth selected but VAULT_TOKEN is empty');
    }
    return token;
  }

  let jwt: string;
  try {
    jwt = await readFile(opts.jwtPath, 'utf8');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to read kubernetes service account token at ${opts.jwtPath}: ${reason}`);
  }
  const trimmedJwt = jwt.trim();

  const mount = opts.mount || 'kubernetes';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VAULT_TIMEOUT_MS;
  const url = `${stripTrailingSlash(opts.addr)}/v1/auth/${mount}/login`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.namespace) headers['X-Vault-Namespace'] = opts.namespace;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jwt: trimmedJwt, role: opts.role }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((cause: unknown) => {
    if (isTimeoutError(cause)) {
      throw new Error(
        `Vault kubernetes login timed out after ${timeoutMs}ms (raise VAULT_TIMEOUT_MS if Vault is slow to respond)`,
      );
    }
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
   * Vault KV-v2 path including the `data/` segment, e.g. `secret/data/myapp/api`.
   * The caller is responsible for the engine prefix and the `data/` segment —
   * this client passes the path through verbatim.
   */
  path: string;
  /** Request timeout in milliseconds. @default 10_000 */
  timeoutMs?: number;
}

/**
 * Read a KV-v2 secret and return its inner data map.
 *
 * KV-v2 wraps the user-set values under `data.data`; this helper unwraps that
 * one level so callers see a flat `Record<string, string>`. Scalar number and
 * boolean values are coerced via `String()`; objects, arrays, and `null`
 * still fail loud — they have no sane env-var representation.
 */
export async function readKvV2(options: ReadKvV2Options): Promise<Record<string, string>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VAULT_TIMEOUT_MS;
  const url = `${stripTrailingSlash(options.addr)}/v1/${stripLeadingSlash(options.path)}`;
  const headers: Record<string, string> = { 'X-Vault-Token': options.token };
  if (options.namespace) headers['X-Vault-Namespace'] = options.namespace;

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((cause: unknown) => {
    if (isTimeoutError(cause)) {
      throw new Error(
        `Vault KV read for ${options.path} timed out after ${timeoutMs}ms (raise VAULT_TIMEOUT_MS if Vault is slow to respond)`,
      );
    }
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
    if (typeof value === 'string') {
      result[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      // Vault KV JSON may carry numeric/boolean scalars — env vars are
      // strings, so coerce deterministically.
      result[key] = String(value);
    } else {
      throw new Error(
        `Vault KV value for ${options.path}#${key} is not a string/number/boolean scalar`,
      );
    }
  }
  return result;
}

/** `AbortSignal.timeout` rejects with 'TimeoutError'; plain aborts with 'AbortError'. */
function isTimeoutError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
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
