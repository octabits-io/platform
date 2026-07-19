/**
 * Integration tests for the Vault secret loader against a real HashiCorp
 * Vault (dev mode via testcontainers; Docker required).
 *
 * The unit tests mock `fetch`; these prove the plain-fetch client speaks the
 * real KV-v2 wire protocol end to end — static-token auth, the `data.data`
 * unwrapping, scalar coercion, and the boot-time `process.env` hydration with
 * its "never clobber an already-set var" precedence rule.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { authenticate, readKvV2 } from './vaultClient.ts';
import { loadVaultSecrets } from './loadVaultSecrets.ts';

const ROOT_TOKEN = 'root-token-for-tests';
const KV_PATH = 'secret/data/app/api';

const ENV_KEYS = [
  'VAULT_ADDR',
  'VAULT_TOKEN',
  'VAULT_AUTH_METHOD',
  'VAULT_NAMESPACE',
  'VAULT_SECRETS_MANIFEST',
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'FEATURE_FLAG',
];

let container: StartedTestContainer;
let addr: string;

beforeAll(async () => {
  container = await new GenericContainer('hashicorp/vault:latest')
    .withEnvironment({
      VAULT_DEV_ROOT_TOKEN_ID: ROOT_TOKEN,
      VAULT_DEV_LISTEN_ADDRESS: '0.0.0.0:8200',
    })
    .withCommand(['server', '-dev'])
    .withExposedPorts(8200)
    // Dev mode boots unsealed + active; sys/health returns 200 once ready.
    .withWaitStrategy(Wait.forHttp('/v1/sys/health', 8200).forStatusCode(200))
    .start();

  addr = `http://${container.getHost()}:${container.getMappedPort(8200)}`;

  // Seed a KV-v2 secret. The dev server mounts the KV-v2 engine at `secret/`,
  // so the write path is `secret/data/<name>` with the values under `data`.
  // Includes a number and a boolean to exercise scalar coercion on read.
  const res = await fetch(`${addr}/v1/${KV_PATH}`, {
    method: 'POST',
    headers: { 'X-Vault-Token': ROOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        db_url: 'postgres://from-vault/app',
        stripe: 'sk_live_from_vault',
        max_conns: 25,
        enabled: true,
      },
    }),
  });
  if (!res.ok) throw new Error(`Failed to seed Vault secret: ${res.status} ${await res.text()}`);
});

afterAll(async () => {
  await container?.stop();
});

describe('Vault client against a real Vault (dev mode)', () => {
  it('authenticate() returns the trimmed static token', async () => {
    expect(await authenticate({ method: 'token', token: `  ${ROOT_TOKEN}\n` })).toBe(ROOT_TOKEN);
  });

  it('readKvV2() unwraps data.data and coerces scalar values to strings', async () => {
    const data = await readKvV2({ addr, token: ROOT_TOKEN, path: KV_PATH });
    expect(data).toEqual({
      db_url: 'postgres://from-vault/app',
      stripe: 'sk_live_from_vault',
      max_conns: '25',
      enabled: 'true',
    });
  });

  it('readKvV2() surfaces a clear error for a missing path', async () => {
    await expect(readKvV2({ addr, token: ROOT_TOKEN, path: 'secret/data/does-not-exist' })).rejects.toThrow(
      /returned 404/,
    );
  });
});

describe('loadVaultSecrets() against a real Vault', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.VAULT_ADDR = addr;
    process.env.VAULT_AUTH_METHOD = 'token';
    process.env.VAULT_TOKEN = ROOT_TOKEN;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it('hydrates process.env from the manifest via static-token auth', async () => {
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: KV_PATH, map: { db_url: 'DATABASE_URL', stripe: 'STRIPE_SECRET_KEY', enabled: 'FEATURE_FLAG' } },
    ]);

    await loadVaultSecrets();

    expect(process.env.DATABASE_URL).toBe('postgres://from-vault/app');
    expect(process.env.STRIPE_SECRET_KEY).toBe('sk_live_from_vault');
    expect(process.env.FEATURE_FLAG).toBe('true');
  });

  it('never clobbers an already-set env var (local override wins)', async () => {
    process.env.DATABASE_URL = 'postgres://local-override';
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: KV_PATH, map: { db_url: 'DATABASE_URL' } },
    ]);

    await loadVaultSecrets();

    expect(process.env.DATABASE_URL).toBe('postgres://local-override');
  });

  it('throws when a manifest key is absent from the Vault secret', async () => {
    process.env.VAULT_SECRETS_MANIFEST = JSON.stringify([
      { path: KV_PATH, map: { nonexistent: 'DATABASE_URL' } },
    ]);

    await expect(loadVaultSecrets()).rejects.toThrow(/missing key "nonexistent"/);
  });
});
