import { describe, it, expect, vi } from 'vitest';
import { IoC, ServiceLifetime } from './container.ts';
import { withScope, forEachScope } from './scopes.ts';
import type { DisposeOptions } from './container.ts';

function trackedScope(disposals: DisposeOptions[], onDispose?: () => void) {
  return {
    dispose: async (opts: DisposeOptions = { commit: true }) => {
      disposals.push(opts);
      onDispose?.();
    },
  };
}

describe('withScope', () => {
  it('disposes with commit: true after success and returns the result', async () => {
    const disposals: DisposeOptions[] = [];
    const result = await withScope(
      () => trackedScope(disposals),
      async () => 42,
    );
    expect(result).toBe(42);
    expect(disposals).toEqual([{ commit: true }]);
  });

  it('disposes with commit: false and rethrows when fn throws', async () => {
    const disposals: DisposeOptions[] = [];
    await expect(
      withScope(() => trackedScope(disposals), async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    expect(disposals).toEqual([{ commit: false }]);
  });

  it('rethrows a commit-dispose failure (work may not be persisted)', async () => {
    await expect(
      withScope(
        () => ({ dispose: async () => { throw new Error('commit failed'); } }),
        async () => 'ok',
      ),
    ).rejects.toThrow('commit failed');
  });

  it("swallows a rollback-dispose failure — fn's error wins", async () => {
    await expect(
      withScope(
        () => ({ dispose: async () => { throw new Error('rollback failed'); } }),
        async () => { throw new Error('work failed'); },
      ),
    ).rejects.toThrow('work failed');
  });

  it('works with real IoC scopes', async () => {
    const root = new IoC<{ value: number }>();
    root.register('value', () => 7, ServiceLifetime.Scoped);
    const seen = vi.fn();
    root.createScope(); // unrelated scope, untouched
    const result = await withScope(
      () => {
        const scope = root.createScope();
        scope.onDispose(seen);
        return scope;
      },
      async (scope) => scope.resolve('value') * 2,
    );
    expect(result).toBe(14);
    expect(seen).toHaveBeenCalledOnce();
  });
});

describe('forEachScope', () => {
  it('processes every key in its own scope and tallies', async () => {
    const perKey: string[] = [];
    const result = await forEachScope(
      {
        keys: ['a', 'b', 'c'],
        createScope: () => trackedScope([]),
      },
      async (_scope, key) => { perKey.push(key); },
    );
    expect(perKey).toEqual(['a', 'b', 'c']);
    expect(result.processed).toEqual(['a', 'b', 'c']);
    expect(result.failed).toEqual([]);
  });

  it('isolates failures: one broken key cannot block the rest', async () => {
    const onError = vi.fn();
    const result = await forEachScope(
      {
        keys: [1, 2, 3],
        createScope: () => trackedScope([]),
        onError,
      },
      async (_scope, key) => {
        if (key === 2) throw new Error('key 2 broke');
      },
    );
    expect(result.processed).toEqual([1, 3]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.key).toBe(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('records createScope failures as failed keys and continues', async () => {
    const result = await forEachScope(
      {
        keys: ['ok', 'boom'],
        createScope: (key) => {
          if (key === 'boom') throw new Error('no scope');
          return trackedScope([]);
        },
      },
      async () => {},
    );
    expect(result.processed).toEqual(['ok']);
    expect(result.failed[0]?.key).toBe('boom');
  });
});
