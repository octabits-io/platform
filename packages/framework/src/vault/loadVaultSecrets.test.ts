import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVaultSecrets } from './loadVaultSecrets.ts';

const VAULT_ENV_KEYS = [
  'VAULT_ADDR',
  'VAULT_TOKEN',
  'VAULT_NAMESPACE',
  'VAULT_AUTH_METHOD',
  'VAULT_K8S_ROLE',
  'VAULT_K8S_JWT_PATH',
  'VAULT_K8S_MOUNT',
  'VAULT_TIMEOUT_MS',
  'VAULT_SECRETS_MANIFEST',
];

const TEST_OUTPUT_KEYS = ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'OTHER_VAR'];

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: '',
    headers: new Headers(),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob()),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    formData: () => Promise.resolve(new FormData()),
    clone: () => jsonResponse(body, init),
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'basic',
    url: '',
  } as unknown as Response;
}

describe('loadVaultSecrets', () => {
  const originalFetch = globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [...VAULT_ENV_KEYS, ...TEST_OUTPUT_KEYS]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const key of [...VAULT_ENV_KEYS, ...TEST_OUTPUT_KEYS]) {
      const prev = savedEnv[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const getMockFetch = () => vi.mocked(globalThis.fetch);

  it('is a no-op when VAULT_ADDR is unset', async () => {
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
    ]);

    await loadVaultSecrets();

    expect(getMockFetch()).not.toHaveBeenCalled();
    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it('is a no-op when manifest is unset', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';

    await loadVaultSecrets();

    expect(getMockFetch()).not.toHaveBeenCalled();
  });

  it('is a no-op when manifest is an empty array', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_SECRETS_MANIFEST = '[]';

    await loadVaultSecrets();

    expect(getMockFetch()).not.toHaveBeenCalled();
  });

  it('throws on malformed manifest JSON', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_SECRETS_MANIFEST = '{not-json';

    await expect(loadVaultSecrets()).rejects.toThrow(/not valid JSON/);
    expect(getMockFetch()).not.toHaveBeenCalled();
  });

  it('throws when manifest has invalid structure', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([{ path: '', map: {} }]);

    await expect(loadVaultSecrets()).rejects.toThrow(/invalid structure/);
  });

  it('hydrates env vars via static-token auth', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200/';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'static-token';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/app/api', map: { db_url: 'DATABASE_URL', stripe: 'STRIPE_SECRET_KEY' } },
    ]);

    getMockFetch().mockResolvedValueOnce(jsonResponse({
      data: { data: { db_url: 'postgres://from-vault', stripe: 'sk_vault' } },
    }));

    await loadVaultSecrets();

    expect(getMockFetch()).toHaveBeenCalledTimes(1);
    const [url, init] = getMockFetch().mock.calls[0]!;
    expect(url).toBe('http://vault:8200/v1/secret/data/app/api');
    expect((init as RequestInit).method).toBe('GET');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Vault-Token']).toBe('static-token');
    expect(headers['X-Vault-Namespace']).toBeUndefined();

    expect(process.env.DATABASE_URL).toBe('postgres://from-vault');
    expect(process.env.STRIPE_SECRET_KEY).toBe('sk_vault');
  });

  it('does not overwrite already-set env vars (env precedence)', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { db_url: 'DATABASE_URL' } },
    ]);
    process.env.DATABASE_URL = 'postgres://local-override';

    getMockFetch().mockResolvedValueOnce(jsonResponse({
      data: { data: { db_url: 'postgres://from-vault' } },
    }));

    await loadVaultSecrets();

    expect(process.env.DATABASE_URL).toBe('postgres://local-override');
  });

  it('sends X-Vault-Namespace when configured', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_NAMESPACE = 'team-platform';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
    ]);

    getMockFetch().mockResolvedValueOnce(jsonResponse({ data: { data: { foo: 'bar' } } }));

    await loadVaultSecrets();

    const headers = (getMockFetch().mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Vault-Namespace']).toBe('team-platform');
  });

  it('uses kubernetes auth when configured (logs in then reads)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'));
    const jwtPath = join(tmpDir, 'token');
    writeFileSync(jwtPath, '  k8s-jwt-value  \n');

    try {
      process.env.VAULT_ADDR = 'http://vault:8200';
      process.env.VAULT_AUTH_METHOD = 'k8s';
      process.env.VAULT_K8S_ROLE = 'app-api';
      process.env.VAULT_K8S_JWT_PATH = jwtPath;
      process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
        { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
      ]);

      getMockFetch()
        .mockResolvedValueOnce(jsonResponse({ auth: { client_token: 'k8s-issued-token' } }))
        .mockResolvedValueOnce(jsonResponse({ data: { data: { foo: 'bar' } } }));

      await loadVaultSecrets();

      expect(getMockFetch()).toHaveBeenCalledTimes(2);
      const [loginUrl, loginInit] = getMockFetch().mock.calls[0]!;
      expect(loginUrl).toBe('http://vault:8200/v1/auth/kubernetes/login');
      expect((loginInit as RequestInit).method).toBe('POST');
      const loginBody = JSON.parse((loginInit as RequestInit).body as string);
      expect(loginBody).toEqual({ jwt: 'k8s-jwt-value', role: 'app-api' });

      const [readUrl, readInit] = getMockFetch().mock.calls[1]!;
      expect(readUrl).toBe('http://vault:8200/v1/secret/data/x');
      const readHeaders = (readInit as RequestInit).headers as Record<string, string>;
      expect(readHeaders['X-Vault-Token']).toBe('k8s-issued-token');

      expect(process.env.DATABASE_URL).toBe('bar');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws a clear error when kubernetes login fails', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'));
    const jwtPath = join(tmpDir, 'token');
    writeFileSync(jwtPath, 'jwt');

    try {
      process.env.VAULT_ADDR = 'http://vault:8200';
      process.env.VAULT_AUTH_METHOD = 'k8s';
      process.env.VAULT_K8S_ROLE = 'app-api';
      process.env.VAULT_K8S_JWT_PATH = jwtPath;
      process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
        { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
      ]);

      getMockFetch().mockResolvedValueOnce(jsonResponse('permission denied', { ok: false, status: 403 }));

      await expect(loadVaultSecrets()).rejects.toThrow(/kubernetes login returned 403/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when KV read fails', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/missing', map: { foo: 'DATABASE_URL' } },
    ]);

    getMockFetch().mockResolvedValueOnce(jsonResponse('not found', { ok: false, status: 404 }));

    await expect(loadVaultSecrets()).rejects.toThrow(/KV read for secret\/data\/missing returned 404/);
  });

  it('throws when a manifest key is missing in the Vault response', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { db_url: 'DATABASE_URL' } },
    ]);

    getMockFetch().mockResolvedValueOnce(jsonResponse({ data: { data: { other: 'value' } } }));

    await expect(loadVaultSecrets()).rejects.toThrow(/missing key "db_url"/);
  });

  it('throws when VAULT_AUTH_METHOD=token but VAULT_TOKEN is missing', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
    ]);

    await expect(loadVaultSecrets()).rejects.toThrow(/VAULT_TOKEN is not set/);
    expect(getMockFetch()).not.toHaveBeenCalled();
  });

  it('throws on an unknown VAULT_AUTH_METHOD instead of silently inferring', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'kubernetes'; // must be 'k8s'
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
    ]);

    await expect(loadVaultSecrets()).rejects.toThrow(
      /unknown VAULT_AUTH_METHOD "kubernetes" \(expected "token" or "k8s"\)/,
    );
    expect(getMockFetch()).not.toHaveBeenCalled();
  });

  it('trims VAULT_TOKEN like the k8s JWT', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = '  static-token \n';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
    ]);

    getMockFetch().mockResolvedValueOnce(jsonResponse({ data: { data: { foo: 'bar' } } }));

    await loadVaultSecrets();

    const headers = (getMockFetch().mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Vault-Token']).toBe('static-token');
  });

  it('uses VAULT_K8S_MOUNT for the kubernetes auth mount path', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'));
    const jwtPath = join(tmpDir, 'token');
    writeFileSync(jwtPath, 'jwt');

    try {
      process.env.VAULT_ADDR = 'http://vault:8200';
      process.env.VAULT_AUTH_METHOD = 'k8s';
      process.env.VAULT_K8S_ROLE = 'app-api';
      process.env.VAULT_K8S_JWT_PATH = jwtPath;
      process.env.VAULT_K8S_MOUNT = 'k8s-prod';
      process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
        { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
      ]);

      getMockFetch()
        .mockResolvedValueOnce(jsonResponse({ auth: { client_token: 'k8s-issued-token' } }))
        .mockResolvedValueOnce(jsonResponse({ data: { data: { foo: 'bar' } } }));

      await loadVaultSecrets();

      const [loginUrl] = getMockFetch().mock.calls[0]!;
      expect(loginUrl).toBe('http://vault:8200/v1/auth/k8s-prod/login');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('treats an empty-string target env var as unset and hydrates it', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { db_url: 'DATABASE_URL' } },
    ]);
    process.env.DATABASE_URL = ''; // blank `FOO=` line in an env file

    getMockFetch().mockResolvedValueOnce(jsonResponse({
      data: { data: { db_url: 'postgres://from-vault' } },
    }));

    await loadVaultSecrets();

    expect(process.env.DATABASE_URL).toBe('postgres://from-vault');
  });

  it('coerces number/boolean KV scalars via String()', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { port: 'DATABASE_URL', flag: 'STRIPE_SECRET_KEY' } },
    ]);

    getMockFetch().mockResolvedValueOnce(jsonResponse({
      data: { data: { port: 5432, flag: true } },
    }));

    await loadVaultSecrets();

    expect(process.env.DATABASE_URL).toBe('5432');
    expect(process.env.STRIPE_SECRET_KEY).toBe('true');
  });

  it('still fails loud on object/array/null KV values', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { nested: 'DATABASE_URL' } },
    ]);

    getMockFetch().mockResolvedValueOnce(jsonResponse({
      data: { data: { nested: { deep: 'value' } } },
    }));

    await expect(loadVaultSecrets()).rejects.toThrow(
      /Vault KV value for secret\/data\/x#nested is not a string\/number\/boolean/,
    );
  });

  it('passes an AbortSignal to fetch (timeout wiring)', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
    ]);

    getMockFetch().mockResolvedValueOnce(jsonResponse({ data: { data: { foo: 'bar' } } }));

    await loadVaultSecrets();

    const init = getMockFetch().mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a hung KV read to a clear boot error after VAULT_TIMEOUT_MS', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_TIMEOUT_MS = '20';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
    ]);

    // Never resolves on its own; rejects only when the timeout signal aborts.
    getMockFetch().mockImplementation((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit).signal!;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );

    await expect(loadVaultSecrets()).rejects.toThrow(/KV read for secret\/data\/x timed out after 20ms/);
  });

  it('maps a hung kubernetes login to a clear boot error after VAULT_TIMEOUT_MS', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'));
    const jwtPath = join(tmpDir, 'token');
    writeFileSync(jwtPath, 'jwt');

    try {
      process.env.VAULT_ADDR = 'http://vault:8200';
      process.env.VAULT_AUTH_METHOD = 'k8s';
      process.env.VAULT_K8S_ROLE = 'app-api';
      process.env.VAULT_K8S_JWT_PATH = jwtPath;
      process.env.VAULT_TIMEOUT_MS = '20';
      process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
        { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
      ]);

      getMockFetch().mockImplementation((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit).signal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      );

      await expect(loadVaultSecrets()).rejects.toThrow(/kubernetes login timed out after 20ms/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on a non-numeric VAULT_TIMEOUT_MS', async () => {
    process.env.VAULT_ADDR = 'http://vault:8200';
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = 'tok';
    process.env.VAULT_TIMEOUT_MS = 'soon';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: 'secret/data/x', map: { foo: 'DATABASE_URL' } },
    ]);

    await expect(loadVaultSecrets()).rejects.toThrow(/VAULT_TIMEOUT_MS must be a positive number/);
    expect(getMockFetch()).not.toHaveBeenCalled();
  });
});
