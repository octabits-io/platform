/**
 * The `main()` tail every API repeats: bootstrap, listen, log, wire graceful
 * shutdown, and turn a bootstrap failure into a logged `process.exit(1)`.
 *
 * The split is deliberate: everything that *can* fail during bootstrap (vault,
 * config, container, queue start, app construction) lives inside the caller's
 * `load()`, so this module owns only the mechanical tail. That is what makes
 * the fatal-error path uniform — anything `load()` throws is logged with the
 * bootstrap logger and exits 1, instead of surfacing as an unhandled rejection.
 *
 * Runtime-agnostic (Bun/Node): the app is only required to have `.listen(port)`,
 * so nothing here imports Elysia. **Importing this module boots nothing** — the
 * server starts only when `runElysiaServer` is called.
 */
import type { Logger } from '../logger/index.ts';
import { registerGracefulShutdown, type GracefulShutdownOptions } from './create-app';

/** Structural contract for the app — satisfied by an Elysia instance. */
export interface ListenableApp {
  listen(port: number | string): unknown;
}

/** What `load()` hands back once bootstrap succeeded. */
export interface LoadedServer<TApp extends ListenableApp> {
  /** The constructed app. `.listen(port)` is called on it. */
  app: TApp;
  /** Port to listen on. */
  port: number | string;
  /**
   * The application logger, used for the started-log and shutdown. Falls back
   * to the bootstrap `logger` when omitted (a container-resolved logger usually
   * only exists once `load()` has run — that is why it is returned, not passed).
   */
  logger?: Logger;
  /**
   * Async teardown (stop queues, drain pools, …), wired to SIGTERM/SIGINT via
   * `registerGracefulShutdown`. Omit to skip signal handling entirely.
   */
  stop?: (signal: string) => Promise<void>;
  /**
   * Replaces the default started-log. Use it to log the extra URLs a service
   * exposes (swagger, metrics, …).
   */
  onStarted?: (info: { app: TApp; port: number | string; logger: Logger }) => void | Promise<void>;
}

export interface RunElysiaServerOptions<TApp extends ListenableApp> {
  /**
   * Bootstrap everything and return the app. Anything thrown here is a fatal
   * startup error: logged via `logger`, then `process.exit(1)`.
   */
  load: () => Promise<LoadedServer<TApp>>;
  /**
   * Bootstrap logger — for fatal startup errors, and the fallback for the
   * started-log/shutdown when `load()` returns no logger. A bootstrap logger
   * must exist *before* config loads (that is the whole point: config loading
   * is one of the things that can fail), so it is passed in rather than
   * derived. Falls back to `console.error` when omitted.
   */
  logger?: Logger;
  /**
   * `false` rethrows bootstrap errors instead of `process.exit(1)` — for tests
   * and for embedders that own the process lifecycle. Default `true`.
   */
  exitProcess?: boolean;
  /** `signals` / `timeoutMs` forwarded to `registerGracefulShutdown`. */
  shutdown?: Pick<GracefulShutdownOptions, 'signals' | 'timeoutMs'>;
}

/** Minimal console-backed logger for when no bootstrap logger was supplied. */
const consoleFallbackLogger: Pick<Logger, 'info' | 'error'> = {
  info: (message: string, context?: unknown) => console.info(message, context ?? ''),
  error: (message: string, error?: unknown) => console.error(message, error ?? ''),
};

/**
 * Run the standard server tail:
 *
 * 1. `await load()` — on throw: log `'Failed to start server'` + `process.exit(1)`
 * 2. `app.listen(port)`
 * 3. `onStarted(...)`, or the default `'Server started'` log
 * 4. `registerGracefulShutdown({ logger, stop })` when `stop` was returned
 *
 * ```ts
 * await runElysiaServer({
 *   logger: bootstrapLogger,
 *   load: async () => {
 *     await loadVaultSecrets();
 *     const config = loadConfig();
 *     const container = await initializeContainer(config);
 *     const logger = container.resolve('logger');
 *     const bossManager = container.resolve('bossManager');
 *     await bossManager.start();
 *     return {
 *       app: createApp(container),
 *       port: config.port,
 *       logger,
 *       stop: async () => { await bossManager.stop(); },
 *       onStarted: ({ port }) => logger.info('API started', {
 *         url: `http://localhost:${port}`,
 *         swagger: config.enableSwagger ? `http://localhost:${port}/swagger` : undefined,
 *       }),
 *     };
 *   },
 * });
 * ```
 *
 * @returns The listening app, or `undefined` when bootstrap failed and
 *   `exitProcess: false` was combined with a stubbed `process.exit`.
 */
export async function runElysiaServer<TApp extends ListenableApp>(
  options: RunElysiaServerOptions<TApp>,
): Promise<TApp | undefined> {
  const { load, logger, exitProcess = true, shutdown } = options;
  const bootstrapLogger = (logger ?? consoleFallbackLogger) as Logger;

  let loaded: LoadedServer<TApp>;
  try {
    loaded = await load();
  } catch (error) {
    bootstrapLogger.error(
      'Failed to start server',
      error instanceof Error ? error : new Error(String(error)),
    );
    if (!exitProcess) throw error;
    process.exit(1);
    // Unreachable in a real runtime; a stubbed process.exit (tests) falls through.
    return undefined;
  }

  const { app, port, stop, onStarted } = loaded;
  const appLogger = loaded.logger ?? bootstrapLogger;

  app.listen(port);

  if (onStarted) {
    await onStarted({ app, port, logger: appLogger });
  } else {
    appLogger.info('Server started', { url: `http://localhost:${port}` });
  }

  if (stop) {
    registerGracefulShutdown({ logger: appLogger, stop, ...shutdown });
  }

  return app;
}
