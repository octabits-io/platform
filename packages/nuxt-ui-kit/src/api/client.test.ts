import { describe, expect, it, vi } from 'vitest';
import type { UserManager } from 'oidc-client-ts';
import { createAccessTokenProvider, resolveApiBaseUrl } from './client.ts';

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
