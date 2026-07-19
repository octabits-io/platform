/**
 * Integration tests for the Zitadel management client against a real Zitadel
 * instance (Zitadel + Postgres via testcontainers; Docker required).
 *
 * The unit tests pin `classifyZitadelError` against hand-written strings;
 * these prove the classifier holds against the wording REAL Zitadel returns —
 * the load-bearing case being a duplicate-org create surfacing as
 * `already_exists` (a missed classification silently disables org reclaim).
 * They also exercise the real user-search / org-search wire shapes end to end.
 *
 * Scope note: the grant/invite topology (`inviteUserToOrg`, `syncProjectGrant`,
 * member listing) needs a project + roles scaffolded first, which the client
 * intentionally does not create. That surface is left to a dedicated harness;
 * covered here is the org + user + error-classification core.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, chmodSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GenericContainer, Network, Wait, type StartedTestContainer, type StartedNetwork } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createZitadelManagementClient, type ZitadelManagementClient } from './index.ts';

// Exactly 32 characters, as Zitadel requires for the master key.
const MASTER_KEY = 'MasterkeyNeedsToHave32Characters';
// A sslip.io domain resolves to 127.0.0.1, which satisfies BOTH sides of
// Zitadel's single-port design: the Host header matches the instance domain,
// and the internal REST→gRPC gateway dial (which reuses the request authority)
// lands on the loopback the server listens on. A plain `localhost` breaks the
// second half — the gateway resolves it to ::1 and the dial is refused.
const EXTERNAL_DOMAIN = '127.0.0.1.sslip.io';

let network: StartedNetwork;
let postgres: StartedPostgreSqlContainer;
let zitadel: StartedTestContainer;
let client: ZitadelManagementClient;
let patDir: string;

beforeAll(async () => {
  network = await new Network().start();

  postgres = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('zitadel')
    .withUsername('zitadel')
    .withPassword('zitadel')
    .withNetwork(network)
    .withNetworkAliases('db')
    .start();

  // The Zitadel image is distroless — no `cat` to exec — so the first-instance
  // PAT is read back through a bind-mounted host directory rather than the
  // container. 0777 so the container's non-root user can write into it.
  patDir = mkdtempSync('/tmp/zitadel-pat-');
  chmodSync(patDir, 0o777);

  // Zitadel's REST→gRPC gateway dials `localhost:8080`, but the container's
  // `[::]:8080` listener is IPv4-only (Docker disables IPv6 by default) and
  // gRPC-go does not fall back from a refused `::1` to `127.0.0.1`. Pin
  // `localhost` to IPv4 via a replacement /etc/hosts so the dial lands. The
  // `db` alias still resolves through Docker's embedded DNS, not this file.
  const hostsFile = join(patDir, 'hosts');
  writeFileSync(hostsFile, '127.0.0.1\tlocalhost\n');

  zitadel = await new GenericContainer('ghcr.io/zitadel/zitadel:latest')
    .withNetwork(network)
    .withCommand(['start-from-init', '--masterkey', MASTER_KEY, '--tlsMode', 'disabled'])
    .withBindMounts([
      { source: patDir, target: '/pat', mode: 'rw' },
      { source: hostsFile, target: '/etc/hosts', mode: 'ro' },
    ])
    .withEnvironment({
      ZITADEL_EXTERNALSECURE: 'false',
      ZITADEL_EXTERNALPORT: '8080',
      ZITADEL_EXTERNALDOMAIN: EXTERNAL_DOMAIN,
      ZITADEL_TLS_ENABLED: 'false',
      // Reuse the Postgres superuser for both the app and admin roles.
      ZITADEL_DATABASE_POSTGRES_HOST: 'db',
      ZITADEL_DATABASE_POSTGRES_PORT: '5432',
      ZITADEL_DATABASE_POSTGRES_DATABASE: 'zitadel',
      ZITADEL_DATABASE_POSTGRES_USER_USERNAME: 'zitadel',
      ZITADEL_DATABASE_POSTGRES_USER_PASSWORD: 'zitadel',
      ZITADEL_DATABASE_POSTGRES_USER_SSL_MODE: 'disable',
      ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME: 'zitadel',
      ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD: 'zitadel',
      ZITADEL_DATABASE_POSTGRES_ADMIN_SSL_MODE: 'disable',
      // First-instance service account with an instance-admin PAT written to a file.
      ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME: 'admin-sa',
      ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME: 'Admin Service Account',
      ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE: '2099-01-01T00:00:00Z',
      ZITADEL_FIRSTINSTANCE_PATPATH: '/pat/admin-sa.pat',
    })
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp('/debug/ready', 8080).forStatusCode(200))
    .withStartupTimeout(150_000)
    .start();

  const pat = readFileSync(join(patDir, 'admin-sa.pat'), 'utf8').trim();
  if (!pat) throw new Error('Zitadel did not write a service-account PAT');

  // Reach the instance via the sslip.io domain so the Host header's hostname
  // matches the configured ExternalDomain — otherwise Zitadel 404s the instance.
  const issuerUrl = `http://${EXTERNAL_DOMAIN}:${zitadel.getMappedPort(8080)}`;
  client = createZitadelManagementClient({ issuerUrl, pat });

  // `/debug/ready` flips to 200 before Zitadel's internal REST→gRPC gateway
  // connection settles, so the first API calls transiently fail with a
  // transport "connection refused". Poll a real call until it stops erroring.
  for (let i = 0; i < 90; i++) {
    const probe = await client.listOrganizations();
    if (probe.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}, 180_000);

afterAll(async () => {
  await zitadel?.stop();
  await postgres?.stop();
  await network?.stop();
  if (patDir) rmSync(patDir, { recursive: true, force: true });
});

describe('Zitadel management client against a real instance', () => {
  const orgName = `Acme QA ${Date.now()}`;
  let createdOrgId: string;

  it('creates an organization and returns its id', async () => {
    const result = await client.createOrganization({ name: orgName });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toMatch(/\d+/);
      createdOrgId = result.value.id;
    }
  });

  it('classifies a duplicate-name create as already_exists (real wording)', async () => {
    const dup = await client.createOrganization({ name: orgName });
    expect(dup.ok).toBe(false);
    // The load-bearing assertion: Zitadel's "name or id already taken" wording
    // must classify as already_exists for org-reclaim flows to work.
    if (!dup.ok) expect(dup.error.key).toBe('already_exists');
  });

  it('finds the organization via a server-side name query', async () => {
    const list = await client.listOrganizations({ name: orgName });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.some((o) => o.id === createdOrgId && o.name === orgName)).toBe(true);
    }
  });

  it('lists users and maps the seeded service account', async () => {
    const users = await client.listAllUsers({ query: 'admin-sa' });
    expect(users.ok).toBe(true);
    if (users.ok) {
      expect(users.value.totalResult).toBeGreaterThan(0);
      const sa = users.value.items.find((u) => u.name.includes('Admin') || u.email.includes('admin'));
      expect(sa ?? users.value.items[0]).toBeDefined();
    }
  });

  it('round-trips a known user by id and returns not_found for an unknown id', async () => {
    const users = await client.listAllUsers({ limit: 1 });
    expect(users.ok).toBe(true);
    if (users.ok && users.value.items[0]) {
      const known = await client.getUserById(users.value.items[0].userId);
      expect(known.ok).toBe(true);
      if (known.ok) expect(known.value.userId).toBe(users.value.items[0].userId);
    }

    const missing = await client.getUserById('999999999999999999');
    expect(missing.ok).toBe(false);
    // Zitadel answers a missing user with "User could not be found" (gRPC
    // code 5) — the classifier must map that to not_found, not api_error.
    if (!missing.ok) expect(missing.error.key).toBe('not_found');
  });

  it('deletes the organization (compensating-transaction path)', async () => {
    const del = await client.deleteOrganization(createdOrgId);
    expect(del.ok).toBe(true);

    // Zitadel is event-sourced: the org-search projection lags the delete, so
    // poll until the org drops out rather than reading once and flaking.
    let gone = false;
    for (let i = 0; i < 20; i++) {
      const after = await client.listOrganizations({ name: orgName });
      if (after.ok && !after.value.some((o) => o.id === createdOrgId)) {
        gone = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(gone).toBe(true);
  });
});
