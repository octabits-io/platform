import { describe, expect, it, vi } from 'vitest';
import { seedAuthBypassSession } from './bypass.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

const base = {
  bypassSecret: 'secret-token',
  issuerUrl: 'https://idp.example',
  clientId: 'client-1',
  isProductionBuild: false,
  warn: () => {},
};

const STORAGE_KEY = 'oidc.user:https://idp.example:client-1';

describe('seedAuthBypassSession', () => {
  it('seeds a fake session with the bypass secret as access token', () => {
    const storage = fakeStorage();
    expect(seedAuthBypassSession({ ...base, storage })).toBe(true);

    const stored = JSON.parse(storage.dump()[STORAGE_KEY]!);
    expect(stored.access_token).toBe('secret-token');
    expect(stored.token_type).toBe('Bearer');
    expect(stored.expires_at).toBeGreaterThan(Date.now() / 1000);
    expect(stored.profile.sub).toBe('e2e-test-user');
  });

  it('refuses to seed in a production build, even with a secret set', () => {
    const storage = fakeStorage();
    const warn = vi.fn();
    expect(
      seedAuthBypassSession({ ...base, isProductionBuild: true, storage, warn }),
    ).toBe(false);
    expect(storage.dump()).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('no-ops without a secret', () => {
    const storage = fakeStorage();
    expect(seedAuthBypassSession({ ...base, bypassSecret: '', storage })).toBe(false);
    expect(storage.dump()).toEqual({});
  });

  it('keeps an existing valid session', () => {
    const valid = JSON.stringify({ expires_at: Math.floor(Date.now() / 1000) + 3600 });
    const storage = fakeStorage({ [STORAGE_KEY]: valid });
    expect(seedAuthBypassSession({ ...base, storage })).toBe(false);
    expect(storage.dump()[STORAGE_KEY]).toBe(valid);
  });

  it('overwrites an expired session', () => {
    const expired = JSON.stringify({ expires_at: Math.floor(Date.now() / 1000) - 10 });
    const storage = fakeStorage({ [STORAGE_KEY]: expired });
    expect(seedAuthBypassSession({ ...base, storage })).toBe(true);
    expect(JSON.parse(storage.dump()[STORAGE_KEY]!).access_token).toBe('secret-token');
  });

  it('overwrites a corrupt entry', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: 'not json{{{' });
    expect(seedAuthBypassSession({ ...base, storage })).toBe(true);
    expect(JSON.parse(storage.dump()[STORAGE_KEY]!).access_token).toBe('secret-token');
  });

  it('uses a custom profile when provided', () => {
    const storage = fakeStorage();
    seedAuthBypassSession({
      ...base,
      storage,
      profile: { sub: 'admin-user', email: 'a@b.c', name: 'Admin' },
    });
    expect(JSON.parse(storage.dump()[STORAGE_KEY]!).profile.sub).toBe('admin-user');
  });
});
