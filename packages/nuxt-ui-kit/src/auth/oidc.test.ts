import { describe, expect, it, vi } from 'vitest';
import { isUnrecoverableRenewError, removeStaleOidcKeys, attachSessionLifecycleHandlers } from './oidc.ts';
import type { UserManager } from 'oidc-client-ts';

function fakeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    get size() {
      return map.size;
    },
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    has: (k: string) => map.has(k),
  };
}

describe('removeStaleOidcKeys', () => {
  it('removes oidc.user keys for other authorities/clients, keeps the current one', () => {
    const storage = fakeStorage({
      'oidc.user:https://idp.example:current-client': 'keep',
      'oidc.user:https://idp.example:old-client': 'stale',
      'oidc.user:https://old-idp.example:current-client': 'stale',
      unrelated: 'keep',
    });
    removeStaleOidcKeys('https://idp.example', 'current-client', storage);
    expect(storage.has('oidc.user:https://idp.example:current-client')).toBe(true);
    expect(storage.has('unrelated')).toBe(true);
    expect(storage.size).toBe(2);
  });
});

describe('isUnrecoverableRenewError', () => {
  it.each(['login_required', 'invalid_grant', 'interaction_required', 'consent_required'])(
    'classifies %s as unrecoverable',
    (code) => {
      expect(isUnrecoverableRenewError(`oops: ${code}`)).toBe(true);
    },
  );

  it('classifies transient errors as recoverable', () => {
    expect(isUnrecoverableRenewError('Failed to fetch')).toBe(false);
    expect(isUnrecoverableRenewError('timeout')).toBe(false);
  });
});

type Handler = (...args: never[]) => void;

function fakeUserManager() {
  const handlers: Record<string, Handler[]> = {
    renewError: [],
    expired: [],
    signedOut: [],
  };
  const um = {
    events: {
      addSilentRenewError: (h: Handler) => void handlers.renewError!.push(h),
      addAccessTokenExpired: (h: Handler) => void handlers.expired!.push(h),
      addUserSignedOut: (h: Handler) => void handlers.signedOut!.push(h),
      removeSilentRenewError: vi.fn(),
      removeAccessTokenExpired: vi.fn(),
      removeUserSignedOut: vi.fn(),
    },
  };
  return { um: um as unknown as UserManager, handlers };
}

describe('attachSessionLifecycleHandlers', () => {
  it('recoverable renew error → renew-failed notice, no redirect', () => {
    const { um, handlers } = fakeUserManager();
    const notify = vi.fn();
    const redirectToLogin = vi.fn();
    attachSessionLifecycleHandlers(um, { notify, redirectToLogin, log: () => {} });

    (handlers.renewError![0] as (e: Error) => void)(new Error('Failed to fetch'));

    expect(notify).toHaveBeenCalledWith({ kind: 'renew-failed', error: expect.any(Error) });
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it('unrecoverable renew error → session-expired notice + redirect', () => {
    const { um, handlers } = fakeUserManager();
    const notify = vi.fn();
    const redirectToLogin = vi.fn();
    attachSessionLifecycleHandlers(um, { notify, redirectToLogin, log: () => {} });

    (handlers.renewError![0] as (e: Error) => void)(new Error('login_required'));

    expect(notify).toHaveBeenCalledWith({ kind: 'session-expired', error: expect.any(Error) });
    expect(redirectToLogin).toHaveBeenCalledOnce();
  });

  it('access token expired → notice + session lost + redirect', () => {
    const { um, handlers } = fakeUserManager();
    const notify = vi.fn();
    const onSessionLost = vi.fn();
    const redirectToLogin = vi.fn();
    attachSessionLifecycleHandlers(um, { notify, onSessionLost, redirectToLogin, log: () => {} });

    (handlers.expired![0] as () => void)();

    expect(notify).toHaveBeenCalledWith({ kind: 'session-expired' });
    expect(onSessionLost).toHaveBeenCalledOnce();
    expect(redirectToLogin).toHaveBeenCalledOnce();
  });

  it('back-channel signout → session lost + redirect, no notice', () => {
    const { um, handlers } = fakeUserManager();
    const notify = vi.fn();
    const onSessionLost = vi.fn();
    const redirectToLogin = vi.fn();
    attachSessionLifecycleHandlers(um, { notify, onSessionLost, redirectToLogin, log: () => {} });

    (handlers.signedOut![0] as () => void)();

    expect(notify).not.toHaveBeenCalled();
    expect(onSessionLost).toHaveBeenCalledOnce();
    expect(redirectToLogin).toHaveBeenCalledOnce();
  });

  it('returns a detach function that unregisters all handlers', () => {
    const { um } = fakeUserManager();
    const detach = attachSessionLifecycleHandlers(um, {
      redirectToLogin: vi.fn(),
      log: () => {},
    });
    detach();
    expect(um.events.removeSilentRenewError).toHaveBeenCalledOnce();
    expect(um.events.removeAccessTokenExpired).toHaveBeenCalledOnce();
    expect(um.events.removeUserSignedOut).toHaveBeenCalledOnce();
  });
});
