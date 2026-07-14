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
import en from '../locales/en.json'

export const DEFAULT_LOCALE = 'en'

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: { en },
})

/** The active locale code — the `getLocale` seam for the kit's date/zod factories. */
export function getLocale(): string {
  return i18n.global.locale.value
}
