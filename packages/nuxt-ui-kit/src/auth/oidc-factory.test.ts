// Both units read `window` (origin for the redirect URIs, localStorage for the
// user store, location for the fallback navigation).
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two OIDC entry points a consumer wires but can never exercise without an
 * IdP — which is exactly why they need unit coverage: in the demo app they are
 * marked "wired for real, but the events never fire".
 *
 * `oidc-client-ts` is mocked to capture the settings object, because that
 * object IS the contract: a wrong `redirect_uri` or a missing
 * `refreshTokenAllowedScope` fails at an identity provider, in production,
 * with an error nobody can reproduce locally.
 */
const { UserManager, WebStorageStateStore, constructed } = vi.hoisted(() => {
  const constructed: Record<string, unknown>[] = [];
  class WebStorageStateStore {
    constructor(public options: { store: unknown }) {}
  }
  const UserManager = vi.fn(function (this: unknown, settings: Record<string, unknown>) {
    constructed.push(settings);
  });
  return { UserManager, WebStorageStateStore, constructed };
});

vi.mock('oidc-client-ts', () => ({ UserManager, WebStorageStateStore }));

import { createLoginRedirector, createUserManagerFactory } from './oidc.ts';
import { ZITADEL_ORG_PROJECT_SCOPE, ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE } from './zitadel.ts';

const config = { issuerUrl: 'https://idp.example', clientId: 'console' };

beforeEach(() => {
  constructed.length = 0;
  vi.clearAllMocks();
});

describe('createUserManagerFactory', () => {
  it('builds the manager lazily and only once', () => {
    const getConfig = vi.fn().mockReturnValue(config);
    const getUserManager = createUserManagerFactory({ getConfig, scope: 'openid' });

    // Nothing is constructed until the first call — the factory runs in a
    // plugin, where `window` may not exist yet.
    expect(UserManager).not.toHaveBeenCalled();

    const first = getUserManager();
    const second = getUserManager();

    expect(first).toBe(second);
    expect(UserManager).toHaveBeenCalledOnce();
    expect(getConfig).toHaveBeenCalledOnce();
  });

  it('derives both redirect URIs from the page origin and the default paths', () => {
    createUserManagerFactory({ getConfig: () => config, scope: 'openid' })();

    expect(constructed[0]).toMatchObject({
      authority: 'https://idp.example',
      client_id: 'console',
      response_type: 'code',
      scope: 'openid',
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: `${window.location.origin}/login`,
      automaticSilentRenew: true,
    });
  });

  it('honours custom paths, scopes and the silent-renew switch', () => {
    createUserManagerFactory({
      getConfig: () => config,
      scope: ZITADEL_ORG_PROJECT_SCOPE,
      refreshTokenAllowedScope: ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE,
      redirectPath: '/callback',
      postLogoutRedirectPath: '/bye',
      automaticSilentRenew: false,
    })();

    expect(constructed[0]).toMatchObject({
      scope: ZITADEL_ORG_PROJECT_SCOPE,
      // Zitadel rejects the URN scopes on the refresh grant — omitting this
      // turns every silent renew into invalid_scope.
      refreshTokenAllowedScope: ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE,
      redirect_uri: `${window.location.origin}/callback`,
      post_logout_redirect_uri: `${window.location.origin}/bye`,
      automaticSilentRenew: false,
    });
  });

  it('omits refreshTokenAllowedScope entirely when not configured', () => {
    createUserManagerFactory({ getConfig: () => config, scope: 'openid' })();

    expect('refreshTokenAllowedScope' in constructed[0]!).toBe(false);
  });

  it('lets the raw settings escape hatch win', () => {
    createUserManagerFactory({
      getConfig: () => config,
      scope: 'openid',
      settings: { response_type: 'id_token', extraQueryParams: { acr_values: 'mfa' } },
    })();

    expect(constructed[0]).toMatchObject({
      response_type: 'id_token',
      extraQueryParams: { acr_values: 'mfa' },
    });
  });

  it('reports missing config but still constructs, so the failure is visible at the IdP hop', () => {
    const onMissingConfig = vi.fn();

    createUserManagerFactory({
      getConfig: () => ({ issuerUrl: '', clientId: '' }),
      scope: 'openid',
      onMissingConfig,
    })();

    expect(onMissingConfig).toHaveBeenCalledOnce();
    expect(UserManager).toHaveBeenCalledOnce();
  });
});

describe('createLoginRedirector', () => {
  const originalLocation = window.location;

  /** happy-dom's location is read-only; swap in a plain object we can inspect. */
  function stubLocation(pathname: string, search = '') {
    const location = { origin: 'https://app.example', pathname, search, href: '' };
    Object.defineProperty(window, 'location', { value: location, writable: true, configurable: true });
    return location;
  }

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
  });

  it('starts a signin redirect carrying the current path as returnUrl state', async () => {
    stubLocation('/contacts', '?page=2');
    const signinRedirect = vi.fn().mockResolvedValue(undefined);

    await createLoginRedirector({
      getUserManager: () => ({ signinRedirect }) as never,
    })();

    expect(signinRedirect).toHaveBeenCalledWith({ state: '/contacts?page=2' });
  });

  it('no-ops on the login page and under /auth/ — redirecting there loops', async () => {
    const signinRedirect = vi.fn();
    const redirect = createLoginRedirector({ getUserManager: () => ({ signinRedirect }) as never });

    stubLocation('/login');
    await redirect();
    stubLocation('/auth/callback');
    await redirect();

    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('honours a custom loginPath and isAuthRoute', async () => {
    const signinRedirect = vi.fn().mockResolvedValue(undefined);
    const redirect = createLoginRedirector({
      getUserManager: () => ({ signinRedirect }) as never,
      loginPath: '/sign-in',
      isAuthRoute: (path) => path.startsWith('/public'),
    });

    stubLocation('/public/pricing');
    await redirect();
    expect(signinRedirect).not.toHaveBeenCalled();

    // The default rule no longer applies — /login is an ordinary route here.
    stubLocation('/login');
    await redirect();
    expect(signinRedirect).toHaveBeenCalledWith({ state: '/login' });
  });

  it('falls back to a plain navigation when the IdP redirect cannot start', async () => {
    const location = stubLocation('/notes', '?s=7');
    const log = vi.fn();

    await createLoginRedirector({
      getUserManager: () => ({ signinRedirect: vi.fn().mockRejectedValue(new Error('no metadata')) }) as never,
      log,
    })();

    // Without this the user sits on a page they are not authenticated for.
    expect(location.href).toBe(`/login?redirect=${encodeURIComponent('/notes?s=7')}`);
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('Zitadel scope presets', () => {
  it('requests the resource-owner and project-roles claims plus a refresh token', () => {
    // These strings are copied into an IdP configuration by hand; a typo is a
    // production-only failure, so the exact set is pinned.
    expect(ZITADEL_ORG_PROJECT_SCOPE.split(' ')).toEqual([
      'openid',
      'profile',
      'email',
      'urn:zitadel:iam:user:resourceowner',
      'urn:zitadel:iam:org:project:roles',
      'offline_access',
    ]);
  });

  it('keeps the refresh-grant scope to standard OIDC only', () => {
    expect(ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE).toBe('openid profile email');
    for (const scope of ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE.split(' ')) {
      expect(ZITADEL_ORG_PROJECT_SCOPE).toContain(scope);
    }
  });
});
