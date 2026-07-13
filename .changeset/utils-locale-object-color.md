---
'@octabits-io/foundation': minor
---

`./utils` gains the last generic utility batch (catalog #25 + #24): `deepMerge`/`DeepPartial` (i18n-overlay merge semantics), `stripDefaults`, the full BCP-47 locale toolkit (`Locale`/`LocaleMap` types, `BCP47_LOCALE_REGEX`, `baseLocaleOf`, `localeFallbackChain`, `resolveLocale`/`resolveLocaleStrict`/`resolveLocaleOrAny`/`anyLocaleValue`, `matchLocaleTag`, `parseAcceptLanguage`, `negotiateContentLocale`, `isLocaleMapComplete`/`missingLocales`/`missingLocalesInUse`, `isLocaleMap`/`resolveLocaleDeep`), WCAG contrast helpers (`getContrastColor`, `getContrastTextMode`, `TAILWIND_COLOR_HEX`/`TAILWIND_COLOR_NAMES`), and `hashCyrb53` — previously a private copy inside `./ical`, now public (the ical fetcher imports it from utils).
