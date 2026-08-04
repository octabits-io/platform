/**
 * SPIKE (elysia-exit-option): Hono port of `../elysia/request-scope`.
 *
 * Per-request IoC scope as ONE wrapping middleware — the shape the exit-option
 * doc predicts should replace Elysia's three-hook triangle
 * (`resolve`/`onAfterResponse`/`onError`, `as: 'scoped'`):
 *
 *   1. success        → after `await next()` with no `c.error`, dispose
 *                       `{ commit: true }`
 *   2. handler threw  → Hono's compose converts the error via `onError` at the
 *                       innermost frame, so `next()` RESOLVES and `c.error` is
 *                       set → dispose `{ commit: false }`
 *   3. `guard` threw  → disposed inline `{ commit: false }` and rethrown,
 *                       before the scope was ever handed to a handler
 *
 * Double-fire cannot happen: there is exactly one post-`next()` dispose site.
 * The `finally` covers the only escape path `next()` has left — a thrown
 * non-`Error` (Hono rethrows those past `onError`) — with `commit: false`.
 *
 * Context typing is DECLARED, not inferred: the middleware's `Env` generic
 * types `c.get('scope')` for consumers whose app declares a matching `Env`
 * (`new Hono<{ Variables: … }>()`). Unlike Elysia's `resolve` inference, the
 * compiler does not prove the middleware is actually mounted on the routes
 * that read the scope — see the spike findings.
 *
 * Reuses the structural contracts from the Elysia module unchanged.
 */
import type { Context, Env, MiddlewareHandler } from 'hono';
import type { DisposeOptions } from '../ioc/index.ts';
import type { Logger } from '../logger/index.ts';
import type {
  CreateScopeResult,
  RequestScope,
  RequestScopeContext,
} from '../elysia/request-scope';

export type { CreateScopeResult, RequestScope, RequestScopeContext };

export interface RequestScopeMiddlewareOptions<
  TScope extends RequestScope,
  TExtras extends Record<string, unknown> = Record<never, never>,
  TKey extends string = 'scope',
> {
  /**
   * Allocate + seed the scope for one request. Same contract as the Elysia
   * plugin: throwing *before* allocation is always safe; checks that need the
   * scope belong in `guard`.
   *
   * NOTE (Hono difference): `params` are the params of the middleware's OWN
   * route match. Mount the middleware on a param-carrying pattern
   * (`app.use('/tenant/:tenantId/*', mw)`) when `createScope` needs them —
   * a bare `app.use(mw)` matches `*` and sees `{}`.
   */
  createScope: (
    ctx: RequestScopeContext,
  ) => CreateScopeResult<TScope, TExtras> | Promise<CreateScopeResult<TScope, TExtras>>;
  /** Context variable the scope is exposed under. Default `'scope'`. */
  contextKey?: TKey;
  /**
   * Optional validation that needs the scope. On throw, the middleware
   * disposes the scope with `{ commit: false }` and rethrows — the error
   * reaches `app.onError`, the scope never reaches a handler.
   */
  guard?: (scope: TScope, ctx: RequestScopeContext) => void | Promise<void>;
  /** Dispose failures are logged here instead of thrown. Omit to drop them silently. */
  logger?: Logger;
}

async function disposeQuietly(
  scope: RequestScope | undefined,
  opts: DisposeOptions,
  logger?: Logger,
): Promise<void> {
  if (!scope) return;
  try {
    await scope.dispose(opts);
  } catch (error) {
    logger?.error(
      `Request-scope dispose failed (commit: ${opts.commit})`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** The Env contribution this middleware makes: the scope variable plus any extras. */
export type RequestScopeEnv<
  TScope extends RequestScope,
  TExtras extends Record<string, unknown> = Record<never, never>,
  TKey extends string = 'scope',
> = { Variables: Record<TKey, TScope> & TExtras };

function requestScopeContext(c: Context): RequestScopeContext {
  return { request: c.req.raw, path: c.req.path, params: c.req.param() as Record<string, string | undefined> };
}

/**
 * Build the request-scope middleware. Mount it on the sub-tree whose handlers
 * need `c.get('scope')`:
 *
 * ```ts
 * const app = new Hono<RequestScopeEnv<MyScope>>();
 * app.use(createRequestScopeMiddleware({ createScope: () => container.createScope() }));
 * app.get('/me', (c) => c.json(c.get('scope').resolve('role')));
 * ```
 */
export function createRequestScopeMiddleware<
  TScope extends RequestScope,
  TExtras extends Record<string, unknown> = Record<never, never>,
  const TKey extends string = 'scope',
>(
  options: RequestScopeMiddlewareOptions<TScope, TExtras, TKey>,
): MiddlewareHandler<RequestScopeEnv<TScope, TExtras, TKey>> {
  const { createScope, guard, logger } = options;
  const contextKey = (options.contextKey ?? 'scope') as TKey;

  return async (c, next) => {
    const ctx = requestScopeContext(c);
    const result = await createScope(ctx);
    // A wrapper carries the scope under `scope` and has no dispose of its
    // own; anything with a dispose IS the scope (same rule as the Elysia plugin).
    const wrapped = typeof (result as { dispose?: unknown }).dispose !== 'function';
    const scope = wrapped ? (result as { scope: TScope }).scope : (result as TScope);
    const extras = wrapped ? (result as { extras: TExtras }).extras : undefined;

    if (guard) {
      try {
        await guard(scope, ctx);
      } catch (error) {
        await disposeQuietly(scope, { commit: false }, logger);
        throw error;
      }
    }

    c.set(contextKey as never, scope as never);
    for (const [key, value] of Object.entries(extras ?? {})) {
      c.set(key as never, value as never);
    }

    let disposed = false;
    try {
      await next();
      disposed = true;
      // A downstream error was converted to a response by `app.onError` at the
      // innermost compose frame — `next()` resolved, but `c.error` carries it.
      await disposeQuietly(scope, { commit: c.error === undefined }, logger);
    } finally {
      // Only reachable when `next()` itself threw (a non-`Error` value that
      // Hono rethrows past `onError`) — never a second dispose after success.
      if (!disposed) await disposeQuietly(scope, { commit: false }, logger);
    }
  };
}
