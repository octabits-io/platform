/**
 * App skeleton + lifecycle helpers (#44): the middleware pipeline every API
 * repeats — `securityHeaders → clientIp → rateLimit → [caller plugins: cors,
 * swagger, …] → errorHandler → routes` — and the graceful-shutdown signal
 * wiring from every `main()`.
 *
 * The caller keeps ownership of anything with its own deps or domain coupling:
 * cors/swagger are passed as ready-built plugin instances (this package does
 * not depend on `@elysiajs/*`), and config/container/secret loading stay in the
 * app's `main()`.
 */
import { Elysia } from 'elysia';
import type { Logger } from '../logger/index.ts';
import { createSecurityHeadersPlugin, type SecurityHeadersOptions } from './security-headers';
import { createClientIpPlugin } from './client-ip';
import { createRateLimit, type RateLimitOptions } from './rate-limit';
import { createErrorHandler, type ErrorHandlerOptions } from './errors';

/**
 * Loose Elysia-instance type — `.use()`-compatible regardless of the
 * instance's basepath/decorators/metadata. Use it to type heterogeneous
 * plugin arrays (e.g. `const plugins: ElysiaPlugin[] = [cors(...)]` +
 * conditional `swagger(...)`) while `createElysiaApp` still preserves the
 * routes' concrete type for Eden Treaty inference.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ElysiaPlugin = Elysia<any, any, any, any, any, any, any>;

type AnyElysia = ElysiaPlugin;

export interface CreateElysiaAppOptions {
  /** `serve.maxRequestBodySize` — omitted entirely when not set. */
  maxRequestBodySize?: number;
  /** Security-headers options; `false` disables the plugin. Mounted first. */
  securityHeaders?: SecurityHeadersOptions | false;
  /**
   * Trusted proxies for X-Forwarded-For resolution. Omit or pass `false` to
   * skip the client-ip plugin (then key rate limiting with
   * `rateLimit.keyByClientIp: false`). Mounted before the rate limiter so its
   * key generator can read `derived.clientIp`.
   */
  clientIp?: string[] | false;
  /** Rate-limit options; omit or pass `false` to skip. */
  rateLimit?: RateLimitOptions | false;
  /**
   * Caller-built plugin instances mounted after the rate limiter in array
   * order — typically `[cors({...})]` plus `swagger({...})` when enabled.
   */
  plugins?: AnyElysia[];
  /** Logger for the error handler (mounted last, just before routes). */
  logger: Logger;
  /** Error-handler options (production redaction, status overrides). */
  errorHandler?: ErrorHandlerOptions;
}

/**
 * Build the standard app: hardening + IP + rate-limit + caller plugins +
 * error handler, then mount `routes`. Returns the composed instance with the
 * routes' type intact, so `export type App = ReturnType<...>` keeps working
 * for Eden Treaty.
 */
export function createElysiaApp<R extends AnyElysia>(routes: R, opts: CreateElysiaAppOptions) {
  const app = new Elysia({
    serve: opts.maxRequestBodySize ? { maxRequestBodySize: opts.maxRequestBodySize } : undefined,
  });

  if (opts.securityHeaders !== false) {
    app.use(createSecurityHeadersPlugin(opts.securityHeaders));
  }
  // An empty trustedProxies array still mounts the plugin (clientIp derives to
  // the socket address) — only `false`/omitted skip it.
  if (opts.clientIp !== undefined && opts.clientIp !== false) {
    app.use(createClientIpPlugin(opts.clientIp));
  }
  if (opts.rateLimit) {
    app.use(createRateLimit(opts.rateLimit));
  }
  for (const plugin of opts.plugins ?? []) {
    app.use(plugin);
  }

  return app.use(createErrorHandler(opts.logger, opts.errorHandler)).use(routes);
}

export interface GracefulShutdownOptions {
  /** Logger for the shutdown notice. */
  logger: Logger;
  /** Async teardown (stop queues, drain pools, …). Runs before `process.exit(0)`. */
  stop: (signal: string) => Promise<void>;
  /** Signals to handle. Default: SIGTERM + SIGINT. */
  signals?: NodeJS.Signals[];
  /** Max time `stop` may take before the process force-exits with code 1. Default 10s. */
  timeoutMs?: number;
}

/**
 * Wire SIGTERM/SIGINT to a graceful teardown: log, run `stop`, exit 0.
 * Replaces the identical `shutdown` tail duplicated in every `main()`.
 *
 * `stop` is bounded by `timeoutMs` (default 10s) — if it hangs, the timeout
 * logs and force-exits with code 1 so the process cannot wedge on teardown.
 * A rejected `stop` is logged and exits with code 1 (never silently swallowed).
 */
export function registerGracefulShutdown({
  logger,
  stop,
  signals = ['SIGTERM', 'SIGINT'],
  timeoutMs = 10_000,
}: GracefulShutdownOptions): void {
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully...`);
    const forceExitTimer = setTimeout(() => {
      logger.error(`Graceful shutdown timed out after ${timeoutMs}ms, forcing exit`);
      process.exit(1);
    }, timeoutMs);
    // Don't let the watchdog itself keep the process alive.
    forceExitTimer.unref?.();
    try {
      await stop(signal);
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      logger.error('Graceful shutdown failed', error instanceof Error ? error : new Error(String(error)));
      process.exit(1);
    }
  };
  for (const signal of signals) {
    // `shutdown` handles its own rejections (see catch above), so `void` here
    // cannot swallow errors.
    process.on(signal, () => void shutdown(signal));
  }
}
