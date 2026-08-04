/**
 * SPIKE (elysia-exit-option): Hono port of `../elysia/create-app`.
 *
 * Same pipeline: `securityHeaders → [caller middleware: cors, …] →
 * errorHandler → routes`. Rate limiting and client-ip are deliberately out of
 * the spike's build scope (gap probe — see the exit-option doc); on Elysia
 * they sit between securityHeaders and the caller plugins.
 *
 * The graceful-shutdown wiring (`registerGracefulShutdown` in `../server/run`)
 * never touched Elysia and is reused as-is.
 */
import { Hono } from 'hono';
import type { Env, MiddlewareHandler } from 'hono';
import type { Logger } from '../logger/index.ts';
import type { ErrorHandlerOptions } from '../elysia/errors';
import { createSecurityHeadersMiddleware, type SecurityHeadersOptions } from './security-headers';
import { registerErrorHandler } from './errors';

export interface CreateHonoAppOptions {
  /** Security-headers options; `false` disables the middleware. Mounted first. */
  securityHeaders?: SecurityHeadersOptions | false;
  /** Caller middleware mounted after security headers in array order (cors, …). */
  middleware?: MiddlewareHandler[];
  /** Logger for the error handler. */
  logger: Logger;
  /** Error-handler options (production redaction). */
  errorHandler?: ErrorHandlerOptions;
}

/**
 * Build the standard app: hardening + caller middleware + error handler, then
 * mount `routes` at `/`. The routes app keeps its own `Env`; the composed
 * outer app is what you serve and test.
 */
export function createHonoApp<E extends Env>(routes: Hono<E>, opts: CreateHonoAppOptions): Hono {
  const app = new Hono();

  if (opts.securityHeaders !== false) {
    app.use(createSecurityHeadersMiddleware(opts.securityHeaders));
  }
  for (const middleware of opts.middleware ?? []) {
    app.use(middleware);
  }
  registerErrorHandler(app, opts.logger, opts.errorHandler);

  return app.route('/', routes);
}
