// Root barrel: framework-light surface only (vue is the sole required peer).
// The OIDC harness lives on `./auth` (oidc-client-ts peer) and the Eden
// Treaty client factory on `./api` (@elysiajs/eden peer) so importing a
// composable never welds those packages to the consumer.

// Org/tenant store core
export { createOrgStoreCore } from './org/orgStore.ts';
export type {
  OrgStoreCore,
  OrgStoreCoreOptions,
  FetchOrganizationsResult,
} from './org/orgStore.ts';

// Runtime-config lookup (window.__APP_CONFIG__ → build-time fallback)
export { resolveRuntimeConfigValue } from './runtimeConfig.ts';

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

// Declarative width-aware header actions (renderer: ./components/PageActions.vue;
// AI trigger primitive: ./components/AiButton.vue)
export { PAGE_HEADER_WIDTH, PAGE_ACTIONS_COLLAPSE_BELOW } from './components/pageActions.ts';
export type { PageActionsItem } from './components/pageActions.ts';

// Per-tab contextual help-panel registry (toggle: ./components/PageUtilityActions.vue)
export { useHelpPanel, HELP_PANEL_KEY } from './composables/useHelpPanel.ts';
export type {
  HelpPanel,
  HelpPanelAction,
  HelpPanelOptions,
  HelpPanelRegistration,
} from './composables/useHelpPanel.ts';

// Form dirty tracking
export { useDirtyTracking } from './composables/useDirtyTracking.ts';

// Offset pagination
export { usePagination } from './composables/usePagination.ts';
