---
'@octabits-io/nuxt-ui-kit': minor
---

Page-chrome layer (reynt catalog #61):

- Source-shipped components `PageHeader.vue` / `PageAction.vue` / `PageActionMenu.vue` / `PageUtilityActions.vue` — standardized page header with enforced conventions (max 3 neutral inline icon actions, destructive actions only in the overflow menu, labeled utility buttons), density variants, tooltip/aria normalization. i18n contract `pageChrome.*` (messages included in `./i18n`).
- `useHelpPanel` + `HELP_PANEL_KEY` (root): provide/inject registry for a per-tab contextual help panel — actions keyed by active tab, open state persisted to a configurable localStorage key, auto-close on tabs without actions.
- `useWizardStepValidation` (on `./zod`): gates a stepper + form wizard by validating only the current step's fields via `schema.pick(...)` — `currentStepValid` / `goNext` / `goPrev` over structural form/stepper surfaces.
