/**
 * The two framework-agnostic halves of the request-scope triangle. `./hono`'s
 * middleware is tested against a live app in `hono/request-scope.test.ts`;
 * these pin the pieces it composes, which any other HTTP glue would reuse.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger/index.ts';
import { disposeScopeQuietly, unwrapCreateScopeResult } from './request-scope.ts';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

describe('unwrapCreateScopeResult', () => {
  it('passes a bare scope through with no extras', () => {
    const scope = { dispose: vi.fn(), resolve: vi.fn() };

    expect(unwrapCreateScopeResult(scope)).toEqual({ scope, extras: undefined });
  });

  it('unwraps the { scope, extras } form', () => {
    const scope = { dispose: vi.fn(), resolve: vi.fn() };
    const extras = { role: 'admin' };

    expect(unwrapCreateScopeResult({ scope, extras })).toEqual({ scope, extras });
  });

  it('discriminates on dispose being callable, not on the key being present', () => {
    // The wrapper is detected by the ABSENCE of a dispose function, so a scope
    // carrying an unrelated `scope` property is still the scope itself.
    const scope = { dispose: vi.fn(), resolve: vi.fn(), scope: 'not-a-wrapper' };

    expect(unwrapCreateScopeResult(scope as never)).toEqual({ scope, extras: undefined });
  });
});

describe('disposeScopeQuietly', () => {
  it('disposes with the given commit flag', async () => {
    const scope = { dispose: vi.fn().mockResolvedValue(undefined), resolve: vi.fn() };

    await disposeScopeQuietly(scope, { commit: true }, silentLogger);

    expect(scope.dispose).toHaveBeenCalledWith({ commit: true });
  });

  it('is a no-op for an undefined scope (creation failed before there was one)', async () => {
    await expect(disposeScopeQuietly(undefined, { commit: false }, silentLogger)).resolves.toBeUndefined();
  });

  it('swallows a dispose failure and logs it', async () => {
    // The response is already sent by the time this runs — throwing here would
    // replace a delivered 200 with a 500 the client never asked about.
    const error = vi.fn();
    const logger = { ...silentLogger, error } as unknown as Logger;
    const scope = { dispose: vi.fn().mockRejectedValue(new Error('commit failed')), resolve: vi.fn() };

    await expect(disposeScopeQuietly(scope, { commit: true }, logger)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]![0])).toContain('commit: true');
  });

  it('swallows the failure even with no logger', async () => {
    const scope = { dispose: vi.fn().mockRejectedValue('not an error'), resolve: vi.fn() };

    await expect(disposeScopeQuietly(scope, { commit: false })).resolves.toBeUndefined();
  });
});
