import {
  UserManager,
  WebStorageStateStore,
  type UserManagerSettings,
} from 'oidc-client-ts';

/** Issuer + client id, resolved at first use (client-side runtime config). */
export interface OidcClientConfig {
  issuerUrl: string;
  clientId: string;
}

export interface UserManagerFactoryOptions {
  /**
   * Resolve the issuer/client pair lazily — typically from a runtime-injected
   * config object (e.g. a K8s-entrypoint `window.__APP_CONFIG__`) falling back
   * to the app's build-time config.
   */
  getConfig: () => OidcClientConfig;
  /** OAuth scopes requested on the initial signin. */
  scope: string;
  /**
   * Scopes sent on the refresh-token grant when the IdP restricts them to a
   * subset of the signin scopes (see `ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE`).
   */
  refreshTokenAllowedScope?: string;
  /** Path the IdP redirects back to after signin. Default `/auth/callback`. */
  redirectPath?: string;
  /** Path the IdP redirects to after logout. Default `/login`. */
  postLogoutRedirectPath?: string;
  /** Default `true`. */
  automaticSilentRenew?: boolean;
  /** Raw oidc-client-ts settings escape hatch, applied last. */
  settings?: Partial<UserManagerSettings>;
  /** Called when issuer/client resolve empty. Default `console.error`. */
  onMissingConfig?: (message: string) => void;
}

/**
 * Lazily-created `UserManager` singleton bound to `window.localStorage`.
 * Call the returned getter from plugins/stores/composables — the manager is
 * constructed on first call (client-side only; requires `window`).
 */
export function createUserManagerFactory(
  options: UserManagerFactoryOptions,
): () => UserManager {
  let userManager: UserManager | null = null;

  return function getUserManager(): UserManager {
    if (userManager) return userManager;

    const { issuerUrl, clientId } = options.getConfig();
    if (!issuerUrl || !clientId) {
      (options.onMissingConfig ?? console.error)(
        'Missing OIDC issuer URL or client id in runtime config',
      );
    }

    userManager = new UserManager({
      authority: issuerUrl,
      client_id: clientId,
      redirect_uri: `${window.location.origin}${options.redirectPath ?? '/auth/callback'}`,
      post_logout_redirect_uri: `${window.location.origin}${options.postLogoutRedirectPath ?? '/login'}`,
      response_type: 'code',
      scope: options.scope,
      automaticSilentRenew: options.automaticSilentRenew ?? true,
      ...(options.refreshTokenAllowedScope
        ? { refreshTokenAllowedScope: options.refreshTokenAllowedScope }
        : {}),
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      ...options.settings,
    });

    return userManager;
  };
}

type StaleKeyStorage = Pick<Storage, 'length' | 'key' | 'removeItem'>;

/**
 * Remove any `oidc.user:` storage keys that don't belong to the current
 * authority+clientId — leftovers from environment switches would otherwise
 * shadow or bloat the session storage.
 */
export function removeStaleOidcKeys(
  authority: string,
  clientId: string,
  storage: StaleKeyStorage = globalThis.localStorage,
): void {
  const currentKey = `oidc.user:${authority}:${clientId}`;
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key && key.startsWith('oidc.user:') && key !== currentKey) {
      storage.removeItem(key);
    }
  }
}

/** Refresh tokens fail unrecoverably with these OIDC error codes — user must re-auth. */
export function isUnrecoverableRenewError(message: string): boolean {
  return (
    message.includes('login_required')
    || message.includes('invalid_grant')
    || message.includes('interaction_required')
    || message.includes('consent_required')
  );
}

export interface LoginRedirectorOptions {
  getUserManager: () => UserManager;
  /** Fallback login page for when `signinRedirect` itself fails. Default `/login`. */
  loginPath?: string;
  /**
   * Paths where redirecting to login would loop (the login/callback pages
   * themselves). Default: `loginPath` and anything under `/auth/`.
   */
  isAuthRoute?: (path: string) => boolean;
  /** Default `console.error`. */
  log?: (message: string, detail?: unknown) => void;
}

/**
 * Build a `redirectToLogin()` that starts an OIDC signin redirect carrying the
 * current path as returnUrl state, with a plain `/login?redirect=` navigation
 * fallback when the IdP redirect cannot even be started. No-ops on auth routes.
 */
export function createLoginRedirector(
  options: LoginRedirectorOptions,
): () => Promise<void> {
  const loginPath = options.loginPath ?? '/login';
  const isAuthRoute =
    options.isAuthRoute
    ?? ((path: string) => path === loginPath || path.startsWith('/auth/'));

  return async function redirectToLogin(): Promise<void> {
    const path = window.location.pathname;
    if (isAuthRoute(path)) return;
    const returnUrl = path + window.location.search;
    try {
      await options.getUserManager().signinRedirect({ state: returnUrl });
    } catch (err) {
      (options.log ?? console.error)(
        '[oidc] signinRedirect failed, falling back to login navigation',
        err,
      );
      window.location.href = `${loginPath}?redirect=${encodeURIComponent(returnUrl)}`;
    }
  };
}

/**
 * A user-facing session event the app should surface (toast/banner). The kit
 * classifies; presentation and copy stay in the app.
 *
 * - `renew-failed` — silent renew failed recoverably (next renew may succeed).
 * - `session-expired` — the session is gone; a login redirect follows.
 */
export type SessionNotice =
  | { kind: 'renew-failed'; error: Error }
  | { kind: 'session-expired'; error?: Error };

export interface SessionLifecycleHandlers {
  /** Start re-authentication (typically from {@link createLoginRedirector}). */
  redirectToLogin: () => void | Promise<void>;
  /** Surface a notice to the user (toast). Optional — omit for headless use. */
  notify?: (notice: SessionNotice) => void;
  /** Clear app-side session state (e.g. reset the auth store's user). */
  onSessionLost?: () => void;
  /** Default `console.warn`. */
  log?: (message: string, detail?: unknown) => void;
}

/**
 * Wire oidc-client-ts session events to app callbacks:
 *
 * - silent-renew error → `notify` (`renew-failed`, or `session-expired` when the
 *   error is unrecoverable — see {@link isUnrecoverableRenewError}); an
 *   unrecoverable error also triggers the login redirect
 * - access token expired without renewal → `notify(session-expired)` +
 *   `onSessionLost` + login redirect
 * - back-channel signout at the IdP → `onSessionLost` + login redirect (no notice
 *   — the user initiated it elsewhere)
 *
 * Returns a detach function.
 */
export function attachSessionLifecycleHandlers(
  userManager: UserManager,
  handlers: SessionLifecycleHandlers,
): () => void {
  const log = handlers.log ?? console.warn;

  const onSilentRenewError = (error: Error) => {
    log('[oidc] silent token renew failed:', error);
    const unrecoverable = isUnrecoverableRenewError(error.message);
    handlers.notify?.(
      unrecoverable
        ? { kind: 'session-expired', error }
        : { kind: 'renew-failed', error },
    );
    if (unrecoverable) {
      void handlers.redirectToLogin();
    }
  };

  const onAccessTokenExpired = () => {
    log('[oidc] access token expired without silent renewal');
    handlers.notify?.({ kind: 'session-expired' });
    handlers.onSessionLost?.();
    void handlers.redirectToLogin();
  };

  const onUserSignedOut = () => {
    log('[oidc] user signed out at IdP (back-channel)');
    handlers.onSessionLost?.();
    void handlers.redirectToLogin();
  };

  userManager.events.addSilentRenewError(onSilentRenewError);
  userManager.events.addAccessTokenExpired(onAccessTokenExpired);
  userManager.events.addUserSignedOut(onUserSignedOut);

  return () => {
    userManager.events.removeSilentRenewError(onSilentRenewError);
    userManager.events.removeAccessTokenExpired(onAccessTokenExpired);
    userManager.events.removeUserSignedOut(onUserSignedOut);
  };
}
