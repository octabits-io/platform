/**
 * Per-request IoC scope as an Elysia plugin: creates a scoped container for
 * every request, exposes it as `ctx.scope`, and guarantees disposal on every
 * exit path — the lifecycle triangle every consumer otherwise has to
 * rediscover by hand:
 *
 *   1. success        → `onAfterResponse` disposes with `{ commit: true }`
 *   2. handler threw  → `onError` disposes with `{ commit: false }`
 *   3. `guard` threw  → disposed inline with `{ commit: false }`, before the
 *                       scope was ever handed to a handler
 *
 * The split between `createScope` and `guard` is deliberate. Anything that
 * must not leak a scope on failure belongs in `guard`: it runs *after*
 * allocation, so the plugin can dispose on throw. `createScope` should only
 * allocate + seed; checks that need nothing from the scope can simply throw
 * before allocating.
 *
 * Both hooks are `{ as: 'scoped' }` so they propagate into the instance that
 * `.use()`s this plugin — without that, composed plugins silently get no
 * scope and no disposal.
 *
 * Double-fire is safe by contract: `RequestScope.dispose` must be idempotent
 * (the IoC container's is — disposables are drained on first call), because
 * an errored request runs `onError` first and `onAfterResponse` after the
 * error response is sent.
 *
 * This module stays decoupled from the IoC class: the scope only has to
 * satisfy the structural {@link RequestScope} contract, so wrapped/augmented
 * containers (e.g. a scope carrying extra request context) type through
 * `ctx.scope` unchanged.
 */
import { Elysia } from 'elysia';
import type { DisposeOptions } from '../ioc/index.ts';
import type { Logger } from '../logger/index.ts';

/** Structural contract the per-request scope must satisfy. */
export interface RequestScope {
  dispose(opts?: DisposeOptions): Promise<void>;
}

/**
 * The request context handed to `createScope` / `guard`. Structural subset of
 * Elysia's handler context — plugins mounted before routes see `params` only
 * as raw strings, hence the loose record type.
 */
export interface RequestScopeContext {
  request: Request;
  path: string;
  params: Record<string, string | undefined>;
}

/** `createScope` may return the scope alone, or the scope plus extra context values. */
export type CreateScopeResult<TScope extends RequestScope, TExtras extends Record<string, unknown>> =
  | TScope
  | { scope: TScope; extras: TExtras };

export interface RequestScopePluginOptions<
  TScope extends RequestScope,
  TExtras extends Record<string, unknown> = Record<never, never>,
  TKey extends string = 'scope',
> {
  /**
   * Allocate + seed the scope for one request (e.g.
   * `container.createScope()` plus scoped registrations derived from the
   * request). Throwing *before* allocation is always safe; if you must throw
   * *after* allocating, dispose what you allocated first — or put the check
   * in `guard`, which exists for exactly that.
   *
   * Return `{ scope, extras }` to merge additional values into the handler
   * context alongside the scope (e.g. an id you already parsed while
   * seeding) — extras are plain context values with no lifecycle of their own.
   */
  createScope: (ctx: RequestScopeContext) => CreateScopeResult<TScope, TExtras> | Promise<CreateScopeResult<TScope, TExtras>>;
  /**
   * Context property the scope is exposed under. Default `'scope'`.
   * Consumers migrating hand-rolled plugins can keep their established name
   * (e.g. `'container'`) instead of touching every handler.
   */
  contextKey?: TKey;
  /**
   * Optional validation that needs the scope (grant checks, row lookups,
   * feature gates). On throw, the plugin disposes the scope with
   * `{ commit: false }` and rethrows — the error reaches the error handler,
   * the scope never reaches a handler.
   */
  guard?: (scope: TScope, ctx: RequestScopeContext) => void | Promise<void>;
  /**
   * Dispose failures cannot change an already-sent response, so they are
   * logged here instead of thrown (and must never mask a guard/handler
   * error). Omit to drop them silently.
   */
  logger?: Logger;
  /** Elysia plugin name (deduplication key). Default: `'request-scope'`. */
  name?: string;
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

/**
 * Build the request-scope plugin. Mount it before the routes that need
 * `ctx.scope`:
 *
 * ```ts
 * const scopePlugin = createRequestScopePlugin({
 *   createScope: ({ request }) => {
 *     const scope = container.createScope<{ role: string }>();
 *     scope.register('role', () => request.headers.get('x-role') ?? 'viewer', ServiceLifetime.Scoped);
 *     return scope;
 *   },
 * });
 *
 * new Elysia().use(scopePlugin).get('/me', ({ scope }) => scope.resolve('role'));
 * ```
 */
export function createRequestScopePlugin<
  TScope extends RequestScope,
  TExtras extends Record<string, unknown> = Record<never, never>,
  const TKey extends string = 'scope',
>(options: RequestScopePluginOptions<TScope, TExtras, TKey>) {
  const { createScope, guard, logger, name = 'request-scope' } = options;
  const contextKey = (options.contextKey ?? 'scope') as TKey;

  const scopeOf = (ctx: unknown): TScope | undefined =>
    (ctx as Record<string, unknown>)[contextKey] as TScope | undefined;

  return new Elysia({ name })
    .resolve({ as: 'scoped' }, async (ctx) => {
      const result = await createScope(ctx as unknown as RequestScopeContext);
      // A wrapper carries the scope under `scope` and has no dispose of its
      // own; anything with a dispose IS the scope.
      const wrapped = typeof (result as { dispose?: unknown }).dispose !== 'function';
      const scope = wrapped ? (result as { scope: TScope }).scope : (result as TScope);
      const extras = wrapped ? (result as { extras: TExtras }).extras : undefined;
      if (guard) {
        try {
          await guard(scope, ctx as unknown as RequestScopeContext);
        } catch (error) {
          await disposeQuietly(scope, { commit: false }, logger);
          throw error;
        }
      }
      return { ...(extras as TExtras), [contextKey]: scope } as TExtras & Record<TKey, TScope>;
    })
    .onAfterResponse({ as: 'scoped' }, async (ctx) => {
      await disposeQuietly(scopeOf(ctx), { commit: true }, logger);
    })
    .onError({ as: 'scoped' }, async (ctx) => {
      // Runs before the error response is sent; `onAfterResponse` still fires
      // afterwards — that second dispose is a no-op on an idempotent scope.
      await disposeQuietly(scopeOf(ctx), { commit: false }, logger);
    });
}
