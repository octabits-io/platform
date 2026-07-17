# @octabits-io/nuxt-ui-kit

## 0.5.0

### Minor Changes

- [`92208e9`](https://github.com/octabits-io/platform/commit/92208e9a2f310f9ee8be33487f92b8ea0371dbe3) - SubSidebar: new `railVisibilityClass` / `toggleVisibilityClass` props so consumers can drive the rail-vs-slideover switch from a container query instead of the viewport (defaults keep the previous `lg:` behavior).

## 0.4.0

### Minor Changes

- [`fc274ea`](https://github.com/octabits-io/platform/commit/fc274ead5423583626444fbd2122db794a1d372f) - `createAiProgressCore` accepts an optional `onTerminal(tracked)` callback, fired once per tracked workflow when polling observes its transition to a terminal status — alongside the existing `completionSignal` bump, but identifying which workflow finished. Enables per-workflow notifications (completion toasts, badges) in consumers.

## 0.3.2

### Patch Changes

- [`e97bfd8`](https://github.com/octabits-io/platform/commit/e97bfd8064067d3ea7f8d03c0d7cb03531af91f7) - Widen the `vue-router` peer range from `^4` to `^4.5.0 || ^5.0.0` (matching `@nuxt/ui`). Nuxt 4.4+ ships vue-router 5, so the old range left the peer unlinkable — pnpm resolved a second router copy for the kit's source-shipped SFCs (`SubSidebar.vue`, `PageHeader.vue`), whose `useRoute()`/`useRouter()` then found no injection and crashed at render time, forcing consumers to work around it with `resolve.dedupe: ['vue-router']`. The kit only uses `useRoute`, `useRouter`, and `RouteLocationRaw`, which are identical across both majors. After bumping, consumers can drop the dedupe workaround.

## 0.3.1

### Patch Changes

- [`130a3ce`](https://github.com/octabits-io/platform/commit/130a3ce838122433deb06810b3106fb2df26358a) - Add `@octabits-io/nuxt-ui-kit/styles.css` — registers the source-shipped
  components as Tailwind v4 sources via `@source "./components"`. Without it,
  utility classes used only inside kit SFCs (e.g. `SubSidebar`'s default
  `w-[240px]`) are missing from consumer builds because Tailwind's automatic
  source detection skips `node_modules`, letting long sidebar item text stretch
  the layout. Consumers add `@import "@octabits-io/nuxt-ui-kit/styles.css";`
  after their Tailwind/`@nuxt/ui` imports.

## 0.3.0

### Minor Changes

- [`f71bc25`](https://github.com/octabits-io/platform/commit/f71bc25b357332461c535e100408948fc7e7f9fa) - Split the root barrel by peer weight and add small drops:

  - **Breaking (pre-1.0 minor):** the OIDC harness moved to the new `./auth` subpath and the Eden Treaty client factory to `./api`. The root barrel keeps only the peer-light surface (composables, org store core), so importing a composable no longer welds `oidc-client-ts` / `@elysiajs/eden` to the consumer — both are now optional peers.
  - `createTreatyClientFactory` accepts a `headers` option, layered after the bearer injector, so consumers can add or override headers without losing Authorization injection.
  - New `resolveRuntimeConfigValue(appConfigKey, fallback?)` (root): the `window.__APP_CONFIG__` → build-time-fallback lookup, SSR-safe.
  - New `./i18n` subpath: `kitMessagesEn` / `kitMessagesDe` / `kitMessagesDeFormal` fragments covering the `errors.*` keys of `createApiErrorMessenger` and the `auth.*` session-lifecycle keys (German in both du/Sie registers).

- [`f71bc25`](https://github.com/octabits-io/platform/commit/f71bc25b357332461c535e100408948fc7e7f9fa) - New `./locale` subpath: the locale-map field editor subsystem (reynt catalog [#59](https://github.com/octabits-io/platform/issues/59), the UI half of framework's `LocaleMap`):

  - `useLocaleTabs` / `useLocaleField` — per-locale tab engine with completeness indicators, register-variant (`de-formal`) inheritance (hidden by default, blank override inherits its base, clearing deletes the key), and quick-translate source/target derivation. Locales come in as a reactive `{ locales, defaultLocale }` source param.
  - `createLocaleDisplay` — collapse a `LocaleMap` to its default-content-locale string for list surfaces.
  - `pruneLocaleMap` — drop `''` leaves so cleared tabs stop shadowing the fallback locale.
  - `LOCALE_FIELD_CONTEXT` + `provideLocaleFieldContext` / `useLocaleFieldContext` — app wiring for the components: a `useSource` factory and an optional `useTranslate` provider (the AI-translate button renders only when provided), both invoked in the component's own setup.
  - Source-shipped components: `LocaleInput.vue`, `LocaleTextarea.vue`, `LocaleTab.vue`, `TranslationBadge.vue` (i18n contract `localeField.*`, messages included in `./i18n`).

  `@octabits-io/framework` (`./utils` locale toolkit) becomes an optional peer, needed only for `./locale`.

- [`f71bc25`](https://github.com/octabits-io/platform/commit/f71bc25b357332461c535e100408948fc7e7f9fa) - Page-chrome layer (reynt catalog [#61](https://github.com/octabits-io/platform/issues/61)):

  - Source-shipped components `PageHeader.vue` / `PageAction.vue` / `PageActionMenu.vue` / `PageUtilityActions.vue` — standardized page header with enforced conventions (max 3 neutral inline icon actions, destructive actions only in the overflow menu, labeled utility buttons), density variants, tooltip/aria normalization. i18n contract `pageChrome.*` (messages included in `./i18n`).
  - `useHelpPanel` + `HELP_PANEL_KEY` (root): provide/inject registry for a per-tab contextual help panel — actions keyed by active tab, open state persisted to a configurable localStorage key, auto-close on tabs without actions.
  - `useWizardStepValidation` (on `./zod`): gates a stepper + form wizard by validating only the current step's fields via `schema.pick(...)` — `currentStepValid` / `goNext` / `goPrev` over structural form/stepper surfaces.

## 0.2.1

### Patch Changes

- [`78a2a88`](https://github.com/octabits-io/platform/commit/78a2a880710084db50ddbaa187928ca4b27c0273) - Fix a type error in `SubSidebar.vue`'s mobile toggle. The inline `@click="open = true"` compiled to a handler returning `boolean`, which is not assignable to `UButton`'s `onClick` type (`(event) => void | Promise<void>` — a union, so TypeScript's "a value-returning function is assignable to a void-returning signature" rule does not apply). Any consumer running `vue-tsc` over the source-shipped SFC hit `TS2322`. The handler is now a named `openSidebar()` function.

- [`3f6c42f`](https://github.com/octabits-io/platform/commit/3f6c42fcb36ffce685b3db89338a1c046f787bfb) - Fix `createApiErrorMessenger`'s validation lookups being undefinable: field paths and message texts are now slugged (lowercased, non-alphanumeric runs collapsed to `_`) before the `validation.fields.<slug>` / `validation.messages.<slug>` lookups, so dotted paths (`items.0.email` → `items_0_email`) and punctuated messages (`Expected string to match 'email'` → `expected_string_to_match_email`) resolve to flat, definable vue-i18n keys instead of always falling through to raw values.

## 0.2.0

### Minor Changes

- [`014a2f0`](https://github.com/octabits-io/platform/commit/014a2f0518169be0136a6466c784d404db6c01a7) - First release (reynt extraction-catalog items 01 + 06 + 07 + 08 + 26 + 27 — the complete Phase B kit): OIDC session harness over `oidc-client-ts` (`createUserManagerFactory`, stale-key cleanup, unrecoverable-renew classification, `createLoginRedirector`, `attachSessionLifecycleHandlers`, Zitadel scope presets), dev/E2E `seedAuthBypassSession` with an unconditional production-build refusal, `createAuthSessionCore` + `createOrgStoreCore` store cores (the app wraps them in its own Pinia stores), `createAuthGuard` route-guard builder with an injected per-app policy hook, an Eden Treaty client factory (`createTreatyClientFactory`, bearer injection, `parseDate: false` default) with `createAccessTokenProvider` / `resolveApiBaseUrl`, `createApiErrorMessenger` (errors._ / validation._ i18n key convention, injected `t`/`te`), the promise-based `useConfirm`/`useConfirmState` pair with a `./components/ConfirmDialog.vue` renderer, `useDirtyTracking` + `usePagination`, `./components/SubSidebar.vue` (responsive list/detail layout with a configurable selection query key), `./zod` `setupZodLocaleSync`, `./dates` (`Period`/`calculateDays`/`shiftIso`, `useDateRangeInput`, `createDateFormatter` + source-shipped `DateInput`/`DateRangeInput`/`PeriodDisplay` components with travel/booking end-date semantics and injected blocked-dates/availability seams), and `./ai` (frontend AI-workflow engine: `useAiWorkflow`/`useAiWorkflowGuard` over injected transport, `createAiProgressCore` cross-page tracking with completion/applied signals, `useAiCardState`, `useActiveAiWorkflowProbe`, `createWorkflowRegistry`, `AiResultReviewCard.vue`). Components ship as `.vue` source with fully explicit imports (`@nuxt/ui/components/*.vue`); `@nuxt/ui`, `vue-i18n`, `vue-router`, `zod`, `date-fns`, and `@internationalized/date` are optional peers.
