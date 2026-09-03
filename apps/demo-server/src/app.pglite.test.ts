/**
 * Route tests against a **real database** — PGlite in memory, so `bun test`
 * covers the database-backed routes with no Docker and no port.
 *
 * `app.test.ts` proves the routes that never touch the database with inert
 * stand-ins; this file is the other half: the same composed app over the same
 * `db/backend-pglite.ts` the server boots on when `DATABASE_URL` is unset,
 * with a real pg-boss (`fromPglite`), the real blob provider, the real outbox
 * + relay, and the encrypted-contact round trip through `bytea`.
 *
 * What each test pins is the seam it crosses: Drizzle over the PGlite driver,
 * the raw-SQL `DemoSql` executor (DDL via `exec`, storage via `query`), pg-boss
 * over the `db` adapter, and in-process LISTEN/NOTIFY delivered at COMMIT.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { testRequest } from '@octabits-io/framework/server/testing';
import { testableHonoApp } from '@octabits-io/framework/hono';
import { createBossManager, type BossManager } from '@octabits-io/framework/queue';
import { createPostgresObjectStorageService } from '@octabits-io/framework/storage/postgres';
import { createEventRelay, type EventRelay } from '@octabits-io/framework/events';
import { createDateProvider } from '@octabits-io/framework/utils';
import type { Logger } from '@octabits-io/framework/logger';
import { loadConfig } from './config.ts';
import { buildContainer, createSystemScopeFactory, EVENT_CHANNEL } from './container.ts';
import { createDemoApp } from './app.ts';
import { createPgliteBackend } from './db/backend-pglite.ts';
import type { DatabaseBackend } from './db/backend.ts';
import { ensureSchema } from './db/ddl.ts';
import { welcomeEmailQueue } from './queues/welcome-email.ts';
import { createInMemoryAiRuntime } from './ai/testing.ts';
import { createInMemoryProposalApplicationStore, createProposalService } from './ai/proposals.ts';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

const ADMIN = { 'x-demo-role': 'admin' };

let backend: DatabaseBackend;
let boss: BossManager;
let relay: EventRelay;
let worker: { stop(): Promise<void> };
let honoApp: ReturnType<typeof createDemoApp>;
let app: ReturnType<typeof testableHonoApp>;

beforeAll(async () => {
  const config = loadConfig();
  backend = await createPgliteBackend({ dataDir: 'memory://', logger: silentLogger });
  await ensureSchema(backend.sql, silentLogger);

  const storage = createPostgresObjectStorageService({
    db: backend.sql,
    autoCreateTable: false,
    createPublicUrl: (_namespace, key) => `http://test/api/files/${key}`,
  });
  boss = createBossManager({ ...backend.boss, logger: silentLogger });
  await boss.start();

  const container = await buildContainer({ config, logger: silentLogger, db: backend.db, storage, boss });
  const createSystemScope = createSystemScopeFactory(container);

  // The queue the contact route enqueues on has to exist for `/api/queue/stats`
  // to report it — creating the worker is what creates it, as in main.ts.
  const w = welcomeEmailQueue.createWorker({ boss: boss.getBoss(), logger: silentLogger });
  const started = await w.startWorker({ createSystemScope }, { pollingIntervalSeconds: 1 });
  if (!started.ok) throw new Error(started.error.message);
  worker = w;

  relay = createEventRelay({
    hub: container.resolve('eventHub'),
    store: container.resolve('eventOutboxStore'),
    listener: backend.createNotifyListener(EVENT_CHANNEL, silentLogger),
    logger: silentLogger,
  });
  await relay.start();

  const ai = createInMemoryAiRuntime({
    host: { contactsService: container.resolve('contactsService'), logger: silentLogger },
    logger: silentLogger,
  });
  const proposals = createProposalService({
    engine: ai.engine,
    contacts: container.resolve('contactsService'),
    notes: container.resolve('notesService'),
    applications: createInMemoryProposalApplicationStore(),
    dateProvider: createDateProvider(),
  });
  honoApp = createDemoApp({ container, config, ai: { ...ai, proposals }, checkReady: () => backend.checkReady() });
  app = testableHonoApp(honoApp);
});

afterAll(async () => {
  await relay.stop();
  await worker.stop();
  await boss.stop();
  await backend.close();
});

/** Read an SSE response until `predicate` matches the text so far (or time out). */
async function readSse(response: Response, predicate: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (!predicate(text) && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

describe('demo-server routes (embedded PGlite)', () => {
  it('reports the database as connected', async () => {
    const res = await testRequest(app, 'GET', '/health/ready');
    expect(res.status).toBe(200);
    expect((res.data as { db: string }).db).toBe('connected');
  });

  it('round-trips an encrypted contact through Drizzle over the PGlite driver', async () => {
    // Email is age-encrypted into one bytea column and blind-indexed into
    // another; the driver returns Uint8Array, the framework's column type
    // hands the PII service the Buffer it expects.
    const created = await testRequest(app, 'POST', '/api/contacts', {
      body: { name: 'Ada', email: 'ada@example.com' },
      headers: ADMIN,
    });
    expect(created.status).toBe(201);
    const contact = created.data as { id: string; email: string };
    expect(contact.email).toBe('ada@example.com');

    const listed = await testRequest(app, 'GET', '/api/contacts', { headers: ADMIN });
    expect(listed.status).toBe(200);
    expect((listed.data as { total: number }).total).toBe(1);

    const one = await testRequest(app, 'GET', `/api/contacts/${contact.id}`, { headers: ADMIN });
    expect(one.status).toBe(200);
    expect((one.data as { email: string }).email).toBe('ada@example.com');
  });

  it('stores and serves a blob through the storage executor seam', async () => {
    const form = new FormData();
    form.set('file', new File(['hello pglite'], 'hello.txt', { type: 'text/plain' }));
    const uploaded = await honoApp.fetch(new Request('http://test/api/files', { method: 'POST', body: form }));
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };

    const served = await honoApp.fetch(new Request(`http://test/api/files/${id}`));
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('hello pglite');
    expect(served.headers.get('content-type')).toContain('text/plain');
    expect(served.headers.get('content-disposition')).toContain('attachment');

    const listed = await testRequest(app, 'GET', '/api/files');
    expect((listed.data as { items: { name: string }[] }).items.map((f) => f.name)).toEqual(['hello.txt']);
  });

  it('runs pg-boss on the PGlite adapter', async () => {
    const res = await testRequest(app, 'GET', '/api/queue/stats');
    expect(res.status).toBe(200);
    const names = (res.data as { queues: { name: string }[] }).queues.map((q) => q.name);
    expect(names).toContain('welcome-email');
  });

  it('delivers a durable event live over in-process NOTIFY, and replays it from the outbox', async () => {
    // Live: subscribe first, then emit. The outbox row and its pg_notify go
    // in one transaction; PGlite delivers the notification at COMMIT, the
    // relay reads the row and the hub pushes it down the stream.
    const live = await honoApp.fetch(new Request('http://test/api/events/stream'));
    expect(live.status).toBe(200);
    const emitted = await testRequest(app, 'POST', '/api/events/demo', { body: { lane: 'durable' } });
    expect(emitted.status).toBe(200);
    const seq = (emitted.data as { seq: number }).seq;
    const liveText = await readSse(live, (t) => t.includes('event: demo.message.recorded'));
    expect(liveText).toContain(`id: ${seq}`);

    // Replay: a reconnect from watermark 0 gets the same envelope back from
    // the outbox without any new NOTIFY.
    const replay = await honoApp.fetch(
      new Request('http://test/api/events/stream', { headers: { 'last-event-id': '0' } }),
    );
    const replayText = await readSse(replay, (t) => t.includes('event: demo.message.recorded'));
    expect(replayText).toContain(`id: ${seq}`);
    expect(replayText).toContain('"lane":"durable"');
  });
});
