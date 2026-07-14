// OIDC session harness (oidc-client-ts)
export {
  createUserManagerFactory,
  removeStaleOidcKeys,
  isUnrecoverableRenewError,
  createLoginRedirector,
  attachSessionLifecycleHandlers,
} from './auth/oidc.ts';
export type {
  OidcClientConfig,
  UserManagerFactoryOptions,
  LoginRedirectorOptions,
  SessionNotice,
  SessionLifecycleHandlers,
} from './auth/oidc.ts';

// Zitadel scope presets
export {
  ZITADEL_ORG_PROJECT_SCOPE,
  ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE,
} from './auth/zitadel.ts';

// Dev/E2E auth bypass
export { seedAuthBypassSession } from './auth/bypass.ts';
export type { SeedAuthBypassOptions, AuthBypassProfile } from './auth/bypass.ts';

// Auth session store core
export { createAuthSessionCore, defaultAuthUserMapper } from './auth/session.ts';
export type {
  AuthSessionCore,
  AuthSessionCoreOptions,
  AuthSessionUser,
} from './auth/session.ts';

// Route guard builder
export { createAuthGuard } from './auth/guard.ts';
export type { AuthGuardOptions, GuardRoute } from './auth/guard.ts';

// Eden Treaty client factory
export {
  createTreatyClientFactory,
  createAccessTokenProvider,
  resolveApiBaseUrl,
} from './api/client.ts';
export type {
  TreatyClientFactoryOptions,
  ResolveApiBaseUrlOptions,
} from './api/client.ts';

// Org/tenant store core
export { createOrgStoreCore } from './org/orgStore.ts';
export type {
  OrgStoreCore,
  OrgStoreCoreOptions,
  FetchOrganizationsResult,
} from './org/orgStore.ts';

// Promise-based confirm dialog (renderer: ./components/ConfirmDialog.vue)
export { useConfirm, useConfirmState } from './composables/useConfirm.ts';
export type { ConfirmOptions } from './composables/useConfirm.ts';

// API error → i18n message mapping (errors.* / validation.* key convention)
export { createApiErrorMessenger } from './composables/apiErrorMessenger.ts';
export type {
  ApiErrorLike,
  ValidationApiErrorLike,
  ApiErrorMessengerOptions,
} from './composables/apiErrorMessenger.ts';

// Form dirty tracking
export { useDirtyTracking } from './composables/useDirtyTracking.ts';

// Offset pagination
export { usePagination } from './composables/usePagination.ts';
