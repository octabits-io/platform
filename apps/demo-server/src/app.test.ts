/**
 * Route tests via `@octabits-io/framework/elysia/testing` — `testRequest`
 * drives the composed app through `app.handle` with no port and no Postgres.
 *
 * The container is built with inert stand-ins for `db`/`storage`/`boss`: the
 * routes under test either never resolve them (health, tools, protected) or
 * fail before touching them (RBAC 403, the scope guard's 400). Anything that
 * genuinely needs Postgres belongs in a docker-backed integration run, not
 * here.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { testRequest, testAuthenticatedRequest } from '@octabits-io/framework/elysia/testing';
import type { Logger } from '@octabits-io/framework/logger';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import type { ObjectStorageService } from '@octabits-io/framework/storage';
import type { BossManager } from '@octabits-io/framework/queue';
import { loadConfig } from './config.ts';
import { buildContainer } from './container.ts';
import { createDemoApp, type App } from './app.ts';
import { createDemoApiKeys } from './api-keys.ts';
import { createInMemoryAiRuntime } from './ai/testing.ts';
import type { ContactsService } from './services/contacts.ts';
import type { Schema } from './db/schema.ts';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

let app: App;
let bearer: string;

beforeAll(async () => {
  const config = loadConfig();
  const container = await buildContainer({
    config,
    logger: silentLogger,
    db: {} as AppDatabase<Schema>,
    storage: {} as ObjectStorageService,
    boss: {} as BossManager,
  });
  const apiKeys = createDemoApiKeys(silentLogger);
  bearer = apiKeys.issue('test', 'viewer');
  // The AI runtime has a real in-memory implementation (see ai/ai.test.ts for
  // its own coverage) — no inert cast needed.
  const ai = createInMemoryAiRuntime({
    host: { contactsService: {} as ContactsService, logger: silentLogger },
    logger: silentLogger,
  });
  app = createDemoApp({ container, config, apiKeys, ai, checkReady: async () => {} });
});

describe('demo-server routes (no Postgres)', () => {
  it('answers liveness', async () => {
    const res = await testRequest(app, 'GET', '/health/live');
    expect(res.status).toBe(200);
  });

  it('slugifies via …/utils', async () => {
    const res = await testRequest(app, 'POST', '/api/tools/slugify', { body: { text: 'Héllo Wörld!' } });
    expect(res.status).toBe(200);
    // German umlauts transliterate (ö → oe) rather than strip.
    expect((res.data as { slug: string }).slug).toBe('hello-woerld');
  });

  it('issues a captcha challenge (no-op provider)', async () => {
    const res = await testRequest(app, 'GET', '/api/captcha/challenge');
    expect(res.status).toBe(200);
  });

  it('rejects a viewer deleting a contact — RBAC fires before any db access', async () => {
    const res = await testRequest(app, 'DELETE', '/api/contacts/6f7c9a34-0f6f-4a3e-9a5d-111111111111', {
      headers: { 'x-demo-role': 'viewer' },
    });
    expect(res.status).toBe(403);
    expect((res.data as { key: string }).key).toBe('forbidden');
  });

  it('rejects an unknown demo role via the request-scope guard', async () => {
    const res = await testRequest(app, 'GET', '/api/contacts', { headers: { 'x-demo-role': 'root' } });
    expect(res.status).toBe(400);
    expect((res.data as { key: string }).key).toBe('invalid_demo_role');
  });

  it('rejects a missing bearer on the protected group', async () => {
    const res = await testRequest(app, 'GET', '/api/protected/whoami');
    expect(res.status).toBe(401);
  });

  it('identifies a valid API key', async () => {
    const res = await testAuthenticatedRequest(app, 'GET', '/api/protected/whoami', {}, `Bearer ${bearer}`);
    expect(res.status).toBe(200);
    expect((res.data as { label: string; role: string }).role).toBe('viewer');
  });
});
