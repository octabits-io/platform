/**
 * Scope lifecycle helpers for non-HTTP contexts — queue handlers, cron
 * sweeps, CLI commands. The Elysia request path has its own equivalent
 * (`../elysia`'s `createRequestScopePlugin`); these cover everything else so
 * `acquire → try → finally dispose` never has to be hand-rolled again.
 */
import type { DisposeOptions } from './container.ts';

/**
 * Type-erased disposable scope: `resolve` by string key, idempotent
 * `dispose`. Use it where a module needs "a scope" without depending on the
 * consumer's service-map type (the circular-dependency dodge consumers
 * otherwise re-declare inline). The IoC container's scopes and any
 * `DisposableServiceResolver` satisfy it structurally.
 */
export interface ErasedScope {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve(key: string): any;
  dispose(opts?: DisposeOptions): Promise<void>;
}

/** Anything `withScope`/`forEachScope` can manage: an idempotent async dispose. */
export interface DisposableScope {
  dispose(opts?: DisposeOptions): Promise<void>;
}

/**
 * Run `fn` inside a freshly created scope with disposal guaranteed:
 *
 * - `fn` resolved → dispose `{ commit: true }`; a dispose failure here is a
 *   real persistence failure and is **rethrown** (the work may not be saved).
 * - `fn` threw → dispose `{ commit: false }`; a dispose failure here is
 *   swallowed (the work is being discarded) and `fn`'s error wins.
 *
 * The same commit/rollback semantics as the Elysia request-scope plugin, for
 * code that has no request.
 */
export async function withScope<TScope extends DisposableScope, R>(
  createScope: () => TScope | Promise<TScope>,
  fn: (scope: TScope) => Promise<R>,
): Promise<R> {
  const scope = await createScope();
  let result: R;
  try {
    result = await fn(scope);
  } catch (error) {
    try {
      await scope.dispose({ commit: false });
    } catch {
      // Discarding the work anyway — fn's error must win.
    }
    throw error;
  }
  await scope.dispose({ commit: true });
  return result;
}

export interface ForEachScopeResult<K> {
  /** Keys whose `fn` (and commit-dispose) completed. */
  processed: K[];
  /** Keys that failed, with their error — the sweep continued past them. */
  failed: Array<{ key: K; error: unknown }>;
}

/**
 * Fan a unit of work out over many scopes with **failure isolation**: each
 * key gets its own scope via {@link withScope}, and one broken key cannot
 * block the rest (its error is recorded and the sweep continues). The
 * canonical shape of a partitioned background sweep — enumerate keys, then
 * per key: open scope → work → dispose — extracted from what every such
 * handler otherwise re-implements, catch-and-continue included.
 */
export async function forEachScope<TScope extends DisposableScope, K>(
  opts: {
    keys: Iterable<K>;
    createScope: (key: K) => TScope | Promise<TScope>;
    /** Observe a failure as it happens (logging); the sweep continues either way. */
    onError?: (key: K, error: unknown) => void;
  },
  fn: (scope: TScope, key: K) => Promise<void>,
): Promise<ForEachScopeResult<K>> {
  const processed: K[] = [];
  const failed: Array<{ key: K; error: unknown }> = [];
  for (const key of opts.keys) {
    try {
      await withScope(() => opts.createScope(key), (scope) => fn(scope, key));
      processed.push(key);
    } catch (error) {
      opts.onError?.(key, error);
      failed.push({ key, error });
    }
  }
  return { processed, failed };
}
