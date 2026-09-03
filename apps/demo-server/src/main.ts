/**
 * Boot sequence, run through `runServer` (`…/server`): everything that
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
import { runServer } from '@octabits-io/framework/server';
import { createDrizzle } from '@octabits-io/framework/drizzle/factory';
import { createBossManager } from '@octabits-io/framework/queue';
import { createPostgresObjectStorageService } from '@octabits-io/framework/storage/postgres';
import { loadConfig } from './config.ts';
import { schema } from './db/schema.ts';
import { ensureSchema } from './db/ddl.ts';
import { runDemoBackfills } from './db/backfills.ts';
import { createPgNotifyListener } from '@octabits-io/framework/events/postgres';
import { createEventRelay } from '@octabits-io/framework/events';
import { EVENT_CHANNEL } from './container.ts';
import { SETTINGS_SCOPE_VALUE } from './services/settings.ts';
import { buildContainer, createSystemScopeFactory } from './container.ts';
import { welcomeEmailQueue } from './queues/welcome-email.ts';
import { createAiRuntime } from './ai/runtime.ts';
import { createDrizzleProposalApplicationStore, createProposalService } from './ai/proposals.ts';
import { createDemoApp } from './app.ts';
import { createBunServer } from './bun-server.ts';

await runServer({
  load: async () => {
    const config = loadConfig();

    // `createLoggerService` returns a LoggerService facade; `.logger` is the root
    // `Logger` every framework module actually takes. Keep the facade around
    // anyway — with `otlp` configured, `shutdown()` is what drains the export
    // buffer, so destructuring `{ logger }` and dropping the rest silently
    // loses whatever hadn't been POSTed yet.
    const loggerService = createLoggerService({
      config: {
        serviceName: 'demo-server',
        logLevel: config.logging.level,
        environment: config.logging.environment,
        // Unset unless OTLP_LOGS_ENDPOINT is — console-only is the default.
        otlp: config.logging.otlp,
      },
    });
    const logger = loggerService.logger;

    const pool = new Pool({ connectionString: config.database.url });
    await ensureSchema(pool, logger);

    const db = createDrizzle(schema, { pool });

    // Data backfills run after the DDL and before anything serves: the shapes
    // exist, and no request can observe a half-migrated row. Already-completed
    // backfills cost one primary-key lookup each.
    await runDemoBackfills(db, logger.child({ component: 'backfill' }));

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

    // The AI workflow engine (`octaflow`) reuses the pool (its tables
    // came up in ensureSchema) and the same pg-boss instance the queue workers
    // run on. The host handed to AI step handlers is a bundle of root
    // singletons — nothing per-step to dispose.
    // Events: the LISTEN side. One dedicated connection (never pooled — a
    // pooled checkout would silently drop the LISTEN registration), the same
    // channel the outbox store notifies on, and the relay bridging it to the
    // in-process hub with watermark catch-up.
    const eventListener = createPgNotifyListener({
      connectionString: config.database.url,
      channel: EVENT_CHANNEL,
      logger: logger.child({ component: 'event-listener' }),
    });
    const eventRelay = createEventRelay({
      hub: container.resolve('eventHub'),
      store: container.resolve('eventOutboxStore'),
      listener: eventListener,
      logger: logger.child({ component: 'event-relay' }),
    });
    await eventRelay.start();

    // Cache-invalidation hints (`…/drizzle/broadcast`). One more LISTEN
    // connection, same direct-connection requirement as the event listener —
    // and the same channel a `PUT /api/settings` publishes on. Losing a hint is
    // survivable by contract; the cache TTL is the backstop.
    const settingsCache = container.resolve('settingsCache');
    const settingsSubscription = await container.resolve('settingsBroadcast').subscribe({
      connectionString: config.database.url,
      onMessage: (message) => {
        settingsCache.invalidate(SETTINGS_SCOPE_VALUE);
        logger.info('Settings cache invalidated by broadcast', { writtenBy: message.writtenBy });
      },
      // At-most-once: anything broadcast while the connection was down is gone,
      // so flush whatever the channel invalidates rather than trusting the gap.
      onReconnect: () => settingsCache.invalidate(SETTINGS_SCOPE_VALUE),
    });

    const ai = createAiRuntime({
      pool,
      boss: boss.getBoss(),
      host: { contactsService: container.resolve('contactsService'), logger },
      logger,
    });
    await ai.start();

    // The apply side of the review loop (ai/proposals.ts): the audit store over
    // Drizzle, the services that own the rows a proposal names, and the engine
    // the proposal is read back from.
    const proposals = createProposalService({
      engine: ai.engine,
      contacts: container.resolve('contactsService'),
      notes: container.resolve('notesService'),
      applications: createDrizzleProposalApplicationStore(db),
      dateProvider: container.resolve('dateProvider'),
    });

    const app = createDemoApp({
      container,
      config,
      ai: { engine: ai.engine, usage: ai.usage, partitionKey: ai.partitionKey, proposals },
      checkReady: async () => {
        await pool.query('SELECT 1');
      },
    });

    // A Hono app is a handler, not a server — `createBunServer` is the local
    // adapter that gives `runServer` the `.listen(port)` it drives. Everything
    // else in this tail (fatal-bootstrap logging, signal wiring, the teardown
    // watchdog) survived the Elysia→Hono swap untouched.
    const server = createBunServer(app, { maxRequestBodySize: 10 * 1024 * 1024 });

    return {
      app: server,
      port: config.port,
      logger,
      onStarted: ({ port }) =>
        logger.info('demo-server listening', { port, url: config.publicBaseUrl }),
      stop: async () => {
        await server.stop();
        await settingsSubscription.stop();
        await eventRelay.stop();
        await ai.stop();
        await dlq.stop();
        await worker.stop();
        await boss.stop();
        await pool.end();
        // Last: everything above still logs on the way down, and this is the
        // call that flushes those records to the collector.
        await loggerService.shutdown();
      },
    };
  },
});
