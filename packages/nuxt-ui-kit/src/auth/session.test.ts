import { describe, expect, it, vi } from 'vitest';
import type { UserManager } from 'oidc-client-ts';
import { createAuthSessionCore, defaultAuthUserMapper } from './session.ts';

const profile = { sub: 'u1', email: 'u1@example.test', name: 'User One', picture: 'p.png' };

function makeUm(overrides: Partial<Record<keyof UserManager, unknown>> = {}) {
  return {
    getUser: vi.fn(async () => ({ expired: false, profile })),
    signinSilent: vi.fn(),
    signinRedirect: vi.fn(async () => {}),
    signinRedirectCallback: vi.fn(),
    removeUser: vi.fn(async () => {}),
    signoutRedirect: vi.fn(async () => {}),
    ...overrides,
  } as unknown as UserManager;
}

const core = (um: UserManager) =>
  createAuthSessionCore({ getUserManager: () => um, mapUser: defaultAuthUserMapper, log: () => {} });

describe('createAuthSessionCore', () => {
  it('checkAuth maps a valid session into user state', async () => {
    const session = core(makeUm());
    await session.checkAuth();
    expect(session.user.value).toEqual({
      id: 'u1',
      email: 'u1@example.test',
      name: 'User One',
      picture: 'p.png',
    });
    expect(session.isAuthenticated.value).toBe(true);
    expect(session.initialized.value).toBe(true);
    expect(session.loading.value).toBe(false);
  });

  it('checkAuth silently renews an expired session that still has a refresh token', async () => {
    const um = makeUm({
      getUser: vi.fn(async () => ({ expired: true, refresh_token: 'rt', profile })),
      signinSilent: vi.fn(async () => ({ expired: false, profile })),
    });
    const session = core(um);
    await session.checkAuth();
    expect(um.signinSilent).toHaveBeenCalledOnce();
    expect(session.isAuthenticated.value).toBe(true);
  });

  it('checkAuth treats a failed silent renew as logged out', async () => {
    const um = makeUm({
      getUser: vi.fn(async () => ({ expired: true, refresh_token: 'rt', profile })),
      signinSilent: vi.fn(async () => {
        throw new Error('login_required');
      }),
    });
    const session = core(um);
    await session.checkAuth();
    expect(session.user.value).toBeNull();
    expect(session.initialized.value).toBe(true);
  });

  it('checkAuth treats an expired session without refresh token as logged out', async () => {
    const um = makeUm({
      getUser: vi.fn(async () => ({ expired: true, profile })),
    });
    const session = core(um);
    await session.checkAuth();
    expect(session.user.value).toBeNull();
    expect(um.signinSilent).not.toHaveBeenCalled();
  });

  it('login starts a signin redirect carrying the return URL as state', async () => {
    const um = makeUm();
    const session = core(um);
    await session.login('/deep/page');
    expect(um.signinRedirect).toHaveBeenCalledWith({ state: '/deep/page' });
    await session.login();
    expect(um.signinRedirect).toHaveBeenCalledWith({ state: '/' });
  });

  it('handleCallback maps the user and returns the state return URL', async () => {
    const um = makeUm({
      signinRedirectCallback: vi.fn(async () => ({ profile, state: '/came/from' })),
    });
    const session = core(um);
    expect(await session.handleCallback()).toBe('/came/from');
    expect(session.isAuthenticated.value).toBe(true);
  });

  it('logout clears state and passes id_token_hint when available', async () => {
    const um = makeUm({
      getUser: vi.fn(async () => ({ expired: false, profile, id_token: 'idt' })),
    });
    const session = core(um);
    await session.checkAuth();
    await session.logout();
    expect(um.removeUser).toHaveBeenCalledOnce();
    expect(session.user.value).toBeNull();
    expect(um.signoutRedirect).toHaveBeenCalledWith({ id_token_hint: 'idt' });
  });

  it('logout omits id_token_hint when there is no session', async () => {
    const um = makeUm({ getUser: vi.fn(async () => null) });
    const session = core(um);
    await session.logout();
    expect(um.signoutRedirect).toHaveBeenCalledWith(undefined);
  });
});
