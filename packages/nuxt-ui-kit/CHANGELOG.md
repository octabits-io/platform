# @octabits-io/nuxt-ui-kit

## 0.12.0

### Minor Changes

- [`771692c`](https://github.com/octabits-io/platform/commit/771692c6f89a987b22ca7160c1064a965f72eb26) - AI trigger normalization: new `AiButton` primitive (sparkles + primary-soft + verb label — the single visual token for "AI acts on data"), and `PageActionsItem` gains `kind: 'ai'` + `description`. PageActions renders AI items as their own cluster: one inline item → verb-labeled AiButton, several → a labeled "AI ∨" dropdown (icons + descriptions per row, i18n key `pageChrome.ai`); collapsed AI items form their own group in the ⋯ menu.

## 0.11.0

### Minor Changes

- [`96bd71b`](https://github.com/octabits-io/platform/commit/96bd71b3ccd44ce6c9f8e115bd846e7dc62348bb) - PageActions: new `help` prop (default `true`) to suppress the built-in Help trigger in nested/panel headers where the page-level header already owns Help.

## 0.10.0

### Minor Changes

- [`ca1eae5`](https://github.com/octabits-io/platform/commit/ca1eae530fea37e481a04f7535a1dba963b9a074) - New `PageActions` component: a declarative, width-aware page-header action cluster. One `PageActionsItem[]` describes every action; `visibility: 'always' | 'auto' | 'menu'` controls placement, and below a header-width threshold (measured by `PageHeader` via ResizeObserver, provided as `PAGE_HEADER_WIDTH`) all `auto` items, utility items, and the Help trigger collapse into the ⋯ menu with their labels intact. Exports `PageActionsItem`, `PAGE_HEADER_WIDTH`, `PAGE_ACTIONS_COLLAPSE_BELOW`.

## 0.9.1

### Patch Changes

- [`be72fa8`](https://github.com/octabits-io/platform/commit/be72fa8e4bf2d30ccbc8ecc18beb3025770b756b) - PageHeader: the actions/utility cluster now wraps on narrow viewports. Previously it was a no-wrap flex row, so labeled actions pushed the overflow menu and Help button off-screen on mobile.

## 0.9.0

### Minor Changes

- [`053cf62`](https://github.com/octabits-io/platform/commit/053cf622544c6eef7bf30331f19354de646df1b0) - PageAction: new `disabledReason` prop. When set, the button renders disabled and the tooltip shows "label — reason", so a blocked action keeps its purpose visible instead of the reason replacing the label. The disabled-hover span wrapper (disabled buttons don't dispatch pointer events) is handled internally — consumers no longer need the outer-UTooltip + `pointer-events-none` workaround.

## 0.8.0

### Minor Changes

- [`16f9a89`](https://github.com/octabits-io/platform/commit/16f9a89235e47664c0413d4ccd7d5806043e5cf5) - Add `FlexiblePeriodInput` component (date window + stay length in nights, composing `DateRangeInput kind="travel"`) and `calculateNights` date helper (exclusive-end night count).

## 0.7.0

### Minor Changes

- [`abb78b7`](https://github.com/octabits-io/platform/commit/abb78b782e69ad01c956c24de2650850caf45bd4) - i18n fragments are English-only: `kitMessagesDe` and `kitMessagesDeFormal` removed

  The kit no longer ships translations beyond English. `kitMessagesEn` doubles as
  the reference for the full key set; apps define their other locales themselves
  as `KitMessages` objects, keeping every translation (and its register/voice)
  app-side. Consumers of the removed German fragments should copy them into their
  own locale files.

## 0.6.0

### Minor Changes

- [`b57afc7`](https://github.com/octabits-io/platform/commit/b57afc7618acf7f93182713442a92d9728b5e438) - i18n fragments gain `errors.exclusion_violation`

  Matches the framework's new `exclusion_violation` database error code (SQLSTATE
  23P01, e.g. overlapping range EXCLUDE constraints). `KitMessages` has a new
  required key, so hand-built message objects need the entry; consumers merging
  the shipped fragments are unaffected.

### Patch Changes

- Updated dependencies [[`b57afc7`](https://github.com/octabits-io/platform/commit/b57afc7618acf7f93182713442a92d9728b5e438)]:
  - @octabits-io/framework@0.4.0

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
