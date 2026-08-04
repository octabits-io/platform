/**
 * Hono port of the `./elysia` create-app plugin (same contract, Hono idiom).
 *
 * Same pipeline: `securityHeaders → [caller middleware: client-ip,
 * rate-limit, cors, …] → errorHandler → routes`.
 *
 * The graceful-shutdown wiring (`registerGracefulShutdown` in `../server/run`)
 * never touched Elysia and is reused as-is.
 */
import { Hono } from 'hono';
import type { Env, MiddlewareHandler } from 'hono';
import type { Logger } from '../logger/index.ts';
import type { ErrorHandlerOptions } from '../server/errors';
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
 *
 * **The return type carries the routes' `Schema` through** — that schema is
 * exactly what `hc<typeof app>` reads, and there are three distinct ways to
 * lose it, all silent (the app keeps serving; only the client type goes empty):
 *
 * 1. Annotating this `Hono`. That is `BlankSchema` — every route gone.
 * 2. Letting the return be *inferred* from `app.route('/', routes)`: inside a
 *    generic function that is `Hono<MergeSchemaPath<S, '/'>, …>`, a conditional
 *    over `S`, and `hc` reads an unreduced conditional as `unknown`.
 * 3. **Decomposing the app type into `<E, S, P>` at all.** Even
 *    `(routes: Hono<E, S, P>): Hono<E, S, P>` loses it for any routes app built
 *    with `.route(...)`: the nested schema does not survive the round trip
 *    through three separate inference sites. Keeping the app type whole
 *    (`T extends Hono<any, any, any>`, the shape `createElysiaApp` also used)
 *    is what preserves it.
 *
 * Mounting at `'/'` merges paths unchanged, so the composed app's schema IS the
 * routes' schema. `create-app.test.ts` pins all of it — including the nested
 * composition, because the flat case passes even when the nested one does not.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createHonoApp<T extends Hono<any, any, any>>(routes: T, opts: CreateHonoAppOptions): T {
  const app = new Hono();

  if (opts.securityHeaders !== false) {
    app.use(createSecurityHeadersMiddleware(opts.securityHeaders));
  }
  for (const middleware of opts.middleware ?? []) {
    app.use(middleware);
  }
  registerErrorHandler(app, opts.logger, opts.errorHandler);

  // Mounting at '/' leaves every path unchanged, so the composed app answers
  // exactly `routes`' schema — the cast states that rather than making the
  // compiler re-derive it (see the note above).
  return app.route('/', routes) as unknown as T;
}

export interface CreateRouteModuleOptions<E extends Env> {
  /**
   * Middleware whose `Env` contribution the routes rely on (request scope,
   * bearer auth, …), mounted in array order before any route.
   */
  middleware: MiddlewareHandler<E>[];
  /**
   * Mount pattern for the middleware. Default `'*'`. Hono middleware only
   * sees `c.req.param()` for params its OWN pattern declares — pass a
   * param-carrying pattern (`'/tenant/:tenantId/*'`) when the middleware
   * reads route params.
   */
  path?: string;
}

/**
 * The route-module convention: build routes against an app that provably has
 * the module's middleware mounted.
 *
 * Hono types `c.get(…)` from the `Env` DECLARED on `new Hono<Env>()` — the
 * compiler never checks that the middleware supplying those variables is
 * actually mounted, so a hand-assembled module can typecheck and read
 * `undefined` at runtime. This factory closes that hole by construction: the
 * only way to get the typed builder app is to hand over middleware matching
 * the same `Env` first.
 *
 * `build` must CHAIN routes and return the chain — Hono accumulates the
 * route types (for `hc` inference) through the chain's return value:
 *
 * ```ts
 * const contacts = createRouteModule(
 *   { middleware: [scopeMw, authMw] },
 *   (app) => app
 *     .get('/', (c) => c.json(c.get('scope').resolve('contacts').list()))
 *     .post('/', octValidator('json', SCHEMA_CONTACT), …),
 * );
 * mainApp.route('/contacts', contacts);
 * ```
 */
export function createRouteModule<E extends Env, TApp extends Hono<E>>(
  options: CreateRouteModuleOptions<E>,
  build: (app: Hono<E>) => TApp,
): TApp {
  const app = new Hono<E>();
  for (const middleware of options.middleware) {
    app.use(options.path ?? '*', middleware);
  }
  return build(app);
}
