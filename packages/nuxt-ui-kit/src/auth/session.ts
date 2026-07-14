import { ref, computed, type Ref, type ComputedRef } from 'vue';
import type { UserManager, UserProfile } from 'oidc-client-ts';

/** Default mapped shape of the authenticated user. */
export interface AuthSessionUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export interface AuthSessionCoreOptions<TUser> {
  getUserManager: () => UserManager;
  /** Map OIDC profile claims to the app's user shape. */
  mapUser: (profile: UserProfile) => TUser;
  /** Default `console.warn`. */
  log?: (message: string, detail?: unknown) => void;
}

export interface AuthSessionCore<TUser> {
  user: Ref<TUser | null>;
  initialized: Ref<boolean>;
  loading: Ref<boolean>;
  isAuthenticated: ComputedRef<boolean>;
  /** Restore the session from storage, silently renewing an expired token. */
  checkAuth: () => Promise<void>;
  /** Start the signin redirect, carrying `returnUrl` as state. */
  login: (returnUrl?: string) => Promise<void>;
  /** Complete the signin redirect; returns the returnUrl state (default `/`). */
  handleCallback: () => Promise<string>;
  /** Clear the local session and redirect to the IdP's logout endpoint. */
  logout: () => Promise<void>;
}

export function defaultAuthUserMapper(profile: UserProfile): AuthSessionUser {
  return {
    id: profile.sub,
    email: profile.email ?? '',
    name: profile.name ?? null,
    picture: (profile.picture as string | undefined) ?? null,
  };
}

/**
 * Reactive OIDC session state + actions — the setup body of an auth store.
 * Wrap it in the app's own store so naming and registration stay app-owned:
 *
 * ```ts
 * export const useAuthStore = defineStore('auth', () =>
 *   createAuthSessionCore({ getUserManager, mapUser: defaultAuthUserMapper }),
 * )
 * ```
 */
export function createAuthSessionCore<TUser = AuthSessionUser>(
  options: AuthSessionCoreOptions<TUser>,
): AuthSessionCore<TUser> {
  const log = options.log ?? console.warn;

  const user = ref<TUser | null>(null) as Ref<TUser | null>;
  const initialized = ref(false);
  const loading = ref(false);

  const isAuthenticated = computed(() => !!user.value);

  async function checkAuth() {
    loading.value = true;
    try {
      const um = options.getUserManager();
      let oidcUser = await um.getUser();

      // Access token expired, but a refresh token is still on file (IdP
      // refresh-token idle expiration is typically much longer than the
      // access-token lifetime). Try to swap it for a fresh access token before
      // treating the user as logged out — without this, closing the browser
      // overnight ends the session at the access-token lifetime instead of the
      // refresh window.
      if (oidcUser && oidcUser.expired && oidcUser.refresh_token) {
        try {
          oidcUser = await um.signinSilent();
        } catch (err) {
          log('[auth] signinSilent failed during checkAuth', err);
          oidcUser = null;
        }
      }

      if (oidcUser && !oidcUser.expired) {
        user.value = options.mapUser(oidcUser.profile);
      } else {
        user.value = null;
      }
    } catch {
      user.value = null;
    } finally {
      initialized.value = true;
      loading.value = false;
    }
  }

  async function login(returnUrl?: string) {
    await options.getUserManager().signinRedirect({
      state: returnUrl ?? '/',
    });
  }

  async function handleCallback(): Promise<string> {
    loading.value = true;
    try {
      const oidcUser = await options.getUserManager().signinRedirectCallback();
      user.value = options.mapUser(oidcUser.profile);
      return (oidcUser.state as string) || '/';
    } finally {
      initialized.value = true;
      loading.value = false;
    }
  }

  async function logout() {
    loading.value = true;
    try {
      const manager = options.getUserManager();
      // Pass the id_token as a hint so the IdP can end the session without
      // prompting the user to pick an account.
      const oidcUser = await manager.getUser();
      const idTokenHint = oidcUser?.id_token;
      await manager.removeUser();
      user.value = null;
      await manager.signoutRedirect(
        idTokenHint ? { id_token_hint: idTokenHint } : undefined,
      );
    } finally {
      loading.value = false;
    }
  }

  return {
    user,
    initialized,
    loading,
    isAuthenticated,
    checkAuth,
    login,
    handleCallback,
    logout,
  };
}
