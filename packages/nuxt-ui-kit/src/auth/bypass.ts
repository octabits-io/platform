type BypassStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface AuthBypassProfile {
  sub: string;
  email: string;
  name: string;
}

export interface SeedAuthBypassOptions {
  /** The shared secret the API accepts as a Bearer token. Falsy → no-op. */
  bypassSecret: string | null | undefined;
  issuerUrl: string;
  clientId: string;
  /**
   * MUST be the build-time production flag (e.g. `import.meta.env.PROD`).
   * When `true` the seed is refused unconditionally — a leaked runtime env var
   * cannot enable the bypass in a production build.
   */
  isProductionBuild: boolean;
  /** Identity baked into the fake session. */
  profile?: AuthBypassProfile;
  /** Fake session lifetime. Default 86400 (24h). */
  sessionTtlSeconds?: number;
  storage?: BypassStorage;
  /** Default `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Dev/E2E auth bypass: seed storage with a fake oidc-client-ts user whose
 * `access_token` is the bypass secret, so the app considers the session
 * authenticated and the API client sends the secret as Bearer.
 *
 * Call from a plugin that runs before the OIDC plugin. Skips seeding when a
 * valid (non-expired) session already exists; overwrites corrupt entries.
 * Returns whether a session was seeded.
 */
export function seedAuthBypassSession(options: SeedAuthBypassOptions): boolean {
  if (options.isProductionBuild) return false;
  if (!options.bypassSecret) return false;

  const storage = options.storage ?? globalThis.localStorage;
  const storageKey = `oidc.user:${options.issuerUrl}:${options.clientId}`;

  const existing = storage.getItem(storageKey);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as { expires_at?: number };
      if ((parsed.expires_at ?? 0) > Date.now() / 1000) return false;
    } catch {
      // corrupt entry — overwrite below
    }
  }

  (options.warn ?? console.warn)(
    '[auth-bypass] Seeding storage with bypass token for dev/E2E testing',
  );

  storage.setItem(
    storageKey,
    JSON.stringify({
      access_token: options.bypassSecret,
      token_type: 'Bearer',
      expires_at: Math.floor(Date.now() / 1000) + (options.sessionTtlSeconds ?? 86400),
      profile: options.profile ?? {
        sub: 'e2e-test-user',
        email: 'e2e@example.test',
        name: 'E2E Test User',
      },
      scope: 'openid profile email',
    }),
  );
  return true;
}
