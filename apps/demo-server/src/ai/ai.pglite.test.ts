/**
 * The AI workflow on the **real** runtime over embedded PGlite — the flow
 * Postgres store and the pg-boss dispatcher on one shared in-process
 * connection, exactly what `bun dev` boots with no `DATABASE_URL`.
 *
 * `ai.test.ts` proves the routes and the review loop on the in-memory engine;
 * this file pins the one thing that engine cannot: that a workflow can be
 * *started* when the store's transaction holds the database's only connection.
 * Before `Dispatcher.prepare` (octaflow), the first start deadlocked here —
 * pg-boss created its queue and read its queue cache on a second connection
 * that PGlite does not have — and the whole process hung on the first trigger.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { testRequest } from '@octabits-io/framework/server/testing';
import { testableHonoApp } from '@octabits-io/framework/hono';
import { createBossManager, type BossManager } from '@octabits-io/framework/queue';
import { createPostgresObjectStorageService } from '@octabits-io/framework/storage/postgres';
import { createDateProvider } from '@octabits-io/framework/utils';
import { createInMemoryAgentLedgerStore } from '@octabits-io/framework/drizzle/agent-ledger';
import type { Logger } from '@octabits-io/framework/logger';
import { loadConfig } from '../config.ts';
import { buildContainer } from '../container.ts';
import { createDemoApp } from '../app.ts';
import { createPgliteBackend } from '../db/backend-pglite.ts';
import type { DatabaseBackend } from '../db/backend.ts';
import { ensureSchema } from '../db/ddl.ts';
import { createAiRuntime, type AiRuntime } from './runtime.ts';
import { createProposalService } from './proposals.ts';
import { CONTACT_BRIEF_TYPE } from './workflows.ts';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

let backend: DatabaseBackend;
let boss: BossManager;
let ai: AiRuntime;
let app: ReturnType<typeof testableHonoApp>;
let contactId: string;

/** Resolve `promise`, or fail loudly after `ms` — a hung request must not hang the suite. */
function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms)),
  ]);
}

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

  ai = createAiRuntime({
    sql: backend.sql,
    boss: boss.getBoss(),
    host: { contactsService: container.resolve('contactsService'), logger: silentLogger },
    logger: silentLogger,
  });
  await ai.start();

  const proposals = createProposalService({
    engine: ai.engine,
    contacts: container.resolve('contactsService'),
    notes: container.resolve('notesService'),
    ledger: createInMemoryAgentLedgerStore(),
    dateProvider: createDateProvider(),
  });
  app = testableHonoApp(
    createDemoApp({
      container,
      config,
      ai: { engine: ai.engine, usage: ai.usage, partitionKey: ai.partitionKey, proposals },
      checkReady: () => backend.checkReady(),
    }),
  );

  const created = await container.resolve('contactsService').create({ name: 'Ada Lovelace', email: 'ada@example.com' });
  if (!created.ok) throw new Error(created.error.message);
  contactId = created.value.id;
});

afterAll(async () => {
  await ai.stop();
  await boss.stop();
  await backend.close();
});

describe('AI workflow on the real runtime over PGlite', () => {
  it('starts a workflow while the store transaction holds the only connection, and runs it to completion', async () => {
    // The deadlock was on the first start of the process: queue DDL + cache
    // read on a connection the open transaction was already holding.
    const triggered = await within(
      5_000,
      testRequest(app, 'POST', '/api/ai/workflows', { body: { type: CONTACT_BRIEF_TYPE, contactId } }),
      'POST /api/ai/workflows',
    );
    expect(triggered.status).toBe(202);
    const { workflowId } = triggered.data as { workflowId: number };

    // A second start on the warm path, for symmetry.
    const again = await within(
      5_000,
      testRequest(app, 'POST', '/api/ai/workflows', { body: { type: CONTACT_BRIEF_TYPE, contactId } }),
      'second POST /api/ai/workflows',
    );
    expect(again.status).toBe(202);

    // The real pg-boss worker (1s polling) drives the four steps.
    let status = 'pending';
    const deadline = Date.now() + 20_000;
    while (status !== 'completed' && status !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const res = await within(5_000, testRequest(app, 'GET', `/api/ai/workflows/${workflowId}`), 'GET workflow');
      status = (res.data as { status: string }).status;
    }
    expect(status).toBe('completed');

    const res = await testRequest(app, 'GET', `/api/ai/workflows/${workflowId}`);
    const workflow = res.data as { output: { propose?: { scope: string } } | null; appliedAt: string | null };
    expect(workflow.output?.propose?.scope).toBe(`contact:${contactId}`);
    expect(workflow.appliedAt).toBeNull();
  }, 30_000);
});
