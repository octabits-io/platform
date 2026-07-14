/** The route fields the guard needs — structurally satisfied by a Nuxt route. */
export interface GuardRoute {
  path: string;
  fullPath: string;
}

export interface AuthGuardOptions<TRoute extends GuardRoute = GuardRoute> {
  /**
   * Ensure the session is restored and report whether the user is
   * authenticated — typically `checkAuth()` once, then `isAuthenticated`.
   */
  ensureAuthenticated: () => Promise<boolean> | boolean;
  /** Routes reachable without auth. Default: `/login` and `/auth/*`. */
  isPublicRoute?: (to: TRoute) => boolean;
  /** Build the login redirect target. Default `/login?redirect=<returnTo>`. */
  loginRedirect?: (returnTo: string) => string;
  /**
   * Per-app policy hook that runs once the user is authenticated — tenant/org
   * validation, role gates, acceptance gates. Return a path to redirect to,
   * or nothing to let the navigation through.
   */
  afterAuthenticated?: (
    to: TRoute,
  ) => Promise<string | undefined | void> | string | undefined | void;
}

/**
 * Build the body of a global auth route-middleware. The returned handler
 * yields a redirect target path or `undefined` to allow navigation; the app's
 * middleware maps that onto its router:
 *
 * ```ts
 * export default defineNuxtRouteMiddleware(async (to) => {
 *   const target = await guard(to)
 *   if (target) return navigateTo(target)
 * })
 * ```
 */
export function createAuthGuard<TRoute extends GuardRoute = GuardRoute>(
  options: AuthGuardOptions<TRoute>,
): (to: TRoute) => Promise<string | undefined> {
  const isPublicRoute =
    options.isPublicRoute
    ?? ((to: TRoute) => to.path === '/login' || to.path.startsWith('/auth/'));
  const loginRedirect =
    options.loginRedirect
    ?? ((returnTo: string) => `/login?redirect=${encodeURIComponent(returnTo)}`);

  return async function guard(to: TRoute): Promise<string | undefined> {
    if (isPublicRoute(to)) return undefined;

    if (!(await options.ensureAuthenticated())) {
      return loginRedirect(to.fullPath);
    }

    const target = await options.afterAuthenticated?.(to);
    return typeof target === 'string' ? target : undefined;
  };
}
