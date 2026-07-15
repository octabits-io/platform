/**
 * Boot sequence, run through `runElysiaServer` (`…/elysia`): everything that
 * can fail lives inside `load()`, so a bad config, unreachable Postgres, or a
 * worker that won't start is logged once as a fatal bootstrap error and the
 * process exits 1 — never an unhandled rejection. Importing this module boots
 * nothing until the call at the bottom.
 *
 * Order inside `load()` is deliberate: config → logger → pool → schema →
 * drizzle → storage → pg-boss → container → workers → app. Everything the app
 * serves must exist before the port opens, so `/health/ready` never answers
 * "ok" on a half-built process. The returned `stop` is wired to
 * SIGTERM/SIGINT by the runner (with a watchdog — a hung teardown force-exits
 * rather than wedging).
 */
import { Pool } from 'pg';
import { createLoggerService } from '@octabits-io/framework/logger';
import { runElysiaServer } from '@octabits-io/framework/elysia';
import { createDrizzle } from '@octabits-io/framework/drizzle/factory';
import { createBossManager } from '@octabits-io/framework/queue';
import { createPostgresObjectStorageService } from '@octabits-io/framework/storage/postgres';
import { loadConfig } from './config.ts';
import { schema } from './db/schema.ts';
import { ensureSchema } from './db/ddl.ts';
import { buildContainer, createSystemScopeFactory } from './container.ts';
import { welcomeEmailQueue } from './queues/welcome-email.ts';
import { createAiRuntime } from './ai/runtime.ts';
import { createDemoApp } from './app.ts';

await runElysiaServer({
  load: async () => {
    const config = loadConfig();

    // `createLoggerService` returns a LoggerService facade; `.logger` is the root
    // `Logger` every framework module actually takes.
    const { logger } = createLoggerService({
      config: {
        serviceName: 'demo-server',
        logLevel: config.logging.level,
        environment: config.logging.environment,
      },
    });

    const pool = new Pool({ connectionString: config.database.url });
    await ensureSchema(pool, logger);

    const db = createDrizzle(schema, { pool });

    const storage = createPostgresObjectStorageService({
      pool,
      // `objectStorageDdl()` already ran in ensureSchema, so the provider must not
      // issue DDL of its own (its default would need DDL rights on every request).
      autoCreateTable: false,
      createPublicUrl: (_namespace, key) => `${config.publicBaseUrl}/api/files/${key}`,
    });

    const boss = createBossManager({ connectionString: config.database.url, logger });
    await boss.start();

    const container = await buildContainer({ config, logger, db, storage, boss });
    const createSystemScope = createSystemScopeFactory(container);

    // The worker and the DLQ handler are separate registrations against the same
    // pg-boss instance. A real deployment often runs them in their own process;
    // co-locating them keeps the demo to one command.
    const worker = welcomeEmailQueue.createWorker({ boss: boss.getBoss(), logger });
    const started = await worker.startWorker({ createSystemScope }, { pollingIntervalSeconds: 1 });
    if (!started.ok) throw new Error(`Failed to start welcome-email worker: ${started.error.message}`);

    const dlq = welcomeEmailQueue.createDlqHandler({ boss: boss.getBoss(), createSystemScope, logger });
    const dlqStarted = await dlq.start({ pollingIntervalSeconds: 5 });
    if (!dlqStarted.ok) throw new Error(`Failed to start welcome-email DLQ handler: ${dlqStarted.error.message}`);

    // The AI workflow engine (`@octabits-io/flow`) reuses the pool (its tables
    // came up in ensureSchema) and the same pg-boss instance the queue workers
    // run on. The host handed to AI step handlers is a bundle of root
    // singletons — nothing per-step to dispose.
    const ai = createAiRuntime({
      pool,
      boss: boss.getBoss(),
      host: { contactsService: container.resolve('contactsService'), logger },
      logger,
    });
    await ai.start();

    const app = createDemoApp({
      container,
      config,
      ai,
      checkReady: async () => {
        await pool.query('SELECT 1');
      },
    });

    return {
      app,
      port: config.port,
      logger,
      onStarted: ({ port }) =>
        logger.info('demo-server listening', { port, url: config.publicBaseUrl }),
      stop: async () => {
        await app.stop();
        await ai.stop();
        await dlq.stop();
        await worker.stop();
        await boss.stop();
        await pool.end();
      },
    };
  },
});
