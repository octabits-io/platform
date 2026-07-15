// OIDC session harness (oidc-client-ts)
export {
  createUserManagerFactory,
  removeStaleOidcKeys,
  isUnrecoverableRenewError,
  createLoginRedirector,
  attachSessionLifecycleHandlers,
} from './oidc.ts';
export type {
  OidcClientConfig,
  UserManagerFactoryOptions,
  LoginRedirectorOptions,
  SessionNotice,
  SessionLifecycleHandlers,
} from './oidc.ts';

// Zitadel scope presets
export {
  ZITADEL_ORG_PROJECT_SCOPE,
  ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE,
} from './zitadel.ts';

// Dev/E2E auth bypass
export { seedAuthBypassSession } from './bypass.ts';
export type { SeedAuthBypassOptions, AuthBypassProfile } from './bypass.ts';

// Auth session store core
export { createAuthSessionCore, defaultAuthUserMapper } from './session.ts';
export type {
  AuthSessionCore,
  AuthSessionCoreOptions,
  AuthSessionUser,
} from './session.ts';

// Route guard builder
export { createAuthGuard } from './guard.ts';
export type { AuthGuardOptions, GuardRoute } from './guard.ts';
