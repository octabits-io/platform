---
'@octabits-io/nuxt-ui-kit': minor
---

New `./locale` subpath: the locale-map field editor subsystem (reynt catalog #59, the UI half of framework's `LocaleMap`):

- `useLocaleTabs` / `useLocaleField` — per-locale tab engine with completeness indicators, register-variant (`de-formal`) inheritance (hidden by default, blank override inherits its base, clearing deletes the key), and quick-translate source/target derivation. Locales come in as a reactive `{ locales, defaultLocale }` source param.
- `createLocaleDisplay` — collapse a `LocaleMap` to its default-content-locale string for list surfaces.
- `pruneLocaleMap` — drop `''` leaves so cleared tabs stop shadowing the fallback locale.
- `LOCALE_FIELD_CONTEXT` + `provideLocaleFieldContext` / `useLocaleFieldContext` — app wiring for the components: a `useSource` factory and an optional `useTranslate` provider (the AI-translate button renders only when provided), both invoked in the component's own setup.
- Source-shipped components: `LocaleInput.vue`, `LocaleTextarea.vue`, `LocaleTab.vue`, `TranslationBadge.vue` (i18n contract `localeField.*`, messages included in `./i18n`).

`@octabits-io/framework` (`./utils` locale toolkit) becomes an optional peer, needed only for `./locale`.
