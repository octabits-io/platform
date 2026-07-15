import { describe, expect, it, vi } from 'vitest';
import type { UserManager } from 'oidc-client-ts';
import { treaty } from '@elysiajs/eden';
import {
  createAccessTokenProvider,
  createTreatyClientFactory,
  resolveApiBaseUrl,
} from './client.ts';

vi.mock('@elysiajs/eden', () => ({ treaty: vi.fn(() => ({})) }));

describe('resolveApiBaseUrl', () => {
  it('prefers the configured URL', () => {
    expect(
      resolveApiBaseUrl({
        configuredUrl: 'https://api.example',
        isProductionBuild: true,
        devFallbackPort: 3002,
        origin: 'https://app.example',
      }),
    ).toBe('https://api.example');
  });

  it('falls back to the page origin in production builds', () => {
    expect(
      resolveApiBaseUrl({
        configuredUrl: '',
        isProductionBuild: true,
        devFallbackPort: 3002,
        origin: 'https://app.example',
      }),
    ).toBe('https://app.example');
  });

  it('falls back to the localhost dev port in dev builds', () => {
    expect(
      resolveApiBaseUrl({
        configuredUrl: undefined,
        isProductionBuild: false,
        devFallbackPort: 3004,
      }),
    ).toBe('http://localhost:3004');
  });
});

describe('createAccessTokenProvider', () => {
  const um = (user: unknown) =>
    ({ getUser: vi.fn(async () => user) }) as unknown as UserManager;

  it('returns the access token of a valid session', async () => {
    const getToken = createAccessTokenProvider(() =>
      um({ expired: false, access_token: 'tok' }),
    );
    expect(await getToken()).toBe('tok');
  });

  it('returns null without a session', async () => {
    const getToken = createAccessTokenProvider(() => um(null));
    expect(await getToken()).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const getToken = createAccessTokenProvider(() =>
      um({ expired: true, access_token: 'tok' }),
    );
    expect(await getToken()).toBeNull();
  });
});

describe('createTreatyClientFactory', () => {
  const treatyMock = vi.mocked(treaty);

  const baseOptions = {
    getBaseUrl: () => 'http://localhost:3002',
    getAccessToken: async () => 'tok',
  };

  const lastConfig = () =>
    treatyMock.mock.calls.at(-1)![1] as {
      headers: Array<unknown>;
      parseDate: boolean;
    };

  it('passes the bearer injector as the sole header source by default', async () => {
    createTreatyClientFactory(baseOptions)();
    const { headers } = lastConfig();
    expect(headers).toHaveLength(1);
    const bearer = headers[0] as () => Promise<unknown>;
    expect(await bearer()).toEqual({ authorization: 'Bearer tok' });
  });

  it('sends no Authorization header without a token', async () => {
    createTreatyClientFactory({
      ...baseOptions,
      getAccessToken: async () => null,
    })();
    const bearer = lastConfig().headers[0] as () => Promise<unknown>;
    expect(await bearer()).toBeUndefined();
  });

  it('layers consumer headers after the bearer injector', () => {
    createTreatyClientFactory({
      ...baseOptions,
      headers: { 'x-app': 'console' },
    })();
    const { headers } = lastConfig();
    expect(headers).toHaveLength(2);
    expect(headers[1]).toEqual({ 'x-app': 'console' });
  });

  it('spreads consumer header arrays in order', () => {
    const fn = () => ({ 'x-b': '2' });
    createTreatyClientFactory({
      ...baseOptions,
      headers: [{ 'x-a': '1' }, fn],
    })();
    const { headers } = lastConfig();
    expect(headers).toHaveLength(3);
    expect(headers[1]).toEqual({ 'x-a': '1' });
    expect(headers[2]).toBe(fn);
  });

  it('memoizes the client and defaults parseDate to false', () => {
    const getClient = createTreatyClientFactory(baseOptions);
    const calls = treatyMock.mock.calls.length;
    expect(getClient()).toBe(getClient());
    expect(treatyMock.mock.calls.length).toBe(calls + 1);
    expect(lastConfig().parseDate).toBe(false);
  });
});
