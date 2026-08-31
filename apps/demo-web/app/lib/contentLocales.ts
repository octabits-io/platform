/**
 * Content locales — the languages a *record* can be written in.
 *
 * A different axis from the UI language: this app ships exactly one interface
 * language (English, `~/lib/i18n.ts`) and still edits content in three. The
 * kit keeps them apart on purpose — `LocaleFieldSource` is what the locale
 * field editors read, and it is app state, never `useI18n().locale`.
 *
 * `de-formal` is a **register variant**: same language, different mode of
 * address. It is not a translation target of its own — a blank `de-formal`
 * value inherits `de` — so the editors hide its tab unless a field opts in
 * with `register-override` (see the public body on `/notes`).
 */
import type { LocaleFieldSource } from '@octabits-io/nuxt-ui-kit/locale'

export const CONTENT_LOCALES = ['en', 'de', 'de-formal']

export const DEFAULT_CONTENT_LOCALE = 'en'

/**
 * The locales a translation is actually *expected* in. `de-formal` is excluded:
 * counting it as missing would report every record incomplete for a value that
 * is supposed to fall through to `de`.
 */
export const TRANSLATABLE_LOCALES = ['en', 'de']

export const LOCALE_FIELD_SOURCE: LocaleFieldSource = {
  locales: CONTENT_LOCALES,
  defaultLocale: DEFAULT_CONTENT_LOCALE,
}
