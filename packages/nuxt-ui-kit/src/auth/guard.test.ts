import { describe, expect, it, vi } from 'vitest';
import { createAuthGuard } from './guard.ts';

const route = (path: string, fullPath = path) => ({ path, fullPath });

describe('createAuthGuard', () => {
  it('lets public routes through without touching auth', async () => {
    const ensureAuthenticated = vi.fn();
    const guard = createAuthGuard({ ensureAuthenticated });

    expect(await guard(route('/login'))).toBeUndefined();
    expect(await guard(route('/auth/callback'))).toBeUndefined();
    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it('redirects unauthenticated users to login with the return URL', async () => {
    const guard = createAuthGuard({ ensureAuthenticated: () => false });
    expect(await guard(route('/acme/listings', '/acme/listings?page=2'))).toBe(
      '/login?redirect=%2Facme%2Flistings%3Fpage%3D2',
    );
  });

  it('lets authenticated users through when no policy hook is set', async () => {
    const guard = createAuthGuard({ ensureAuthenticated: async () => true });
    expect(await guard(route('/dashboard'))).toBeUndefined();
  });

  it('runs the afterAuthenticated policy hook and honors its redirect', async () => {
    const guard = createAuthGuard({
      ensureAuthenticated: () => true,
      afterAuthenticated: async (to) =>
        to.path.startsWith('/gone') ? '/tenants' : undefined,
    });
    expect(await guard(route('/gone/page'))).toBe('/tenants');
    expect(await guard(route('/fine/page'))).toBeUndefined();
  });

  it('treats a void policy-hook return as allow', async () => {
    const guard = createAuthGuard({
      ensureAuthenticated: () => true,
      afterAuthenticated: () => {},
    });
    expect(await guard(route('/x'))).toBeUndefined();
  });

  it('supports custom public-route and login-redirect strategies', async () => {
    const guard = createAuthGuard({
      ensureAuthenticated: () => false,
      isPublicRoute: (to) => to.path === '/welcome',
      loginRedirect: (returnTo) => `/signin?next=${returnTo}`,
    });
    expect(await guard(route('/welcome'))).toBeUndefined();
    expect(await guard(route('/private'))).toBe('/signin?next=/private');
  });
});
