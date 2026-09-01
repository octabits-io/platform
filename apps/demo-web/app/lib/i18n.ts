/**
 * Plain vue-i18n, no `@nuxtjs/i18n`.
 *
 * The kit's seams only need a `t`/`te`/`locale` triple (`createApiErrorMessenger`
 * takes `t`/`te`; the source-shipped SFCs call `useI18n()` themselves), and the
 * demo ships one locale — so the module's routing/lazy-loading/SEO machinery
 * would be weight without a job. `createI18n` + `vueApp.use()` in a plugin is
 * the whole integration.
 *
 * The instance is created here rather than inside the plugin so non-component
 * callers (the zod locale-sync plugin) can read `locale` without a Nuxt
 * context.
 */
import { createI18n } from 'vue-i18n'
import { kitMessagesEn } from '@octabits-io/nuxt-ui-kit/i18n'
import en from '../locales/en.json'

export const DEFAULT_LOCALE = 'en'

type Messages = Record<string, unknown>

/**
 * Deep merge, app wins.
 *
 * A shallow spread is not enough: app and kit both contribute to the same
 * namespaces (`errors.forbidden` is app copy that mentions the demo role,
 * `errors.unique_violation` is the kit's default; `ai.review.*` is the kit's,
 * `ai.brief.*` is this app's). A shallow merge would drop whichever half lost
 * the key collision, and the loss is silent — vue-i18n renders the missing
 * path as text.
 */
function deepMerge(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key]
    out[key] =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        && value && typeof value === 'object' && !Array.isArray(value)
        ? deepMerge(existing as Messages, value as Messages)
        : value
  }
  return out
}

/**
 * `kitMessagesEn` supplies every key the KIT asks for — `errors.*` (the
 * framework's response keys), `auth.*` (session toasts), and the component
 * contracts (`pageChrome.*`, `dateRange.*`, `flexPeriod.*`, `dateInput.*`,
 * `localeField.*`, `period.*`, `ai.review.*`). This app therefore ships only
 * its own copy, plus the handful of overrides where demo-specific wording is
 * the point. Hand-copying that key set (which this app did until 2026-08-31)
 * is the same list maintained twice, and it drifts silently.
 */
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  // Cast back to the app's own message shape: vue-i18n infers its whole
  // generic surface (including `locale` being a ref) from this object, and an
  // index-signature type collapses that inference.
  messages: { en: deepMerge(kitMessagesEn as unknown as Messages, en) as typeof en },
})

/** The active locale code — the `getLocale` seam for the kit's date/zod factories. */
export function getLocale(): string {
  return i18n.global.locale.value
}
