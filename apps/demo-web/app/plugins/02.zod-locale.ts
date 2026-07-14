/**
 * Keep Zod's built-in messages in the active UI language.
 *
 * The kit does not watch anything itself — `onLocaleChange` is the seam where
 * the app hands it whatever reactivity it uses. Here that is a plain `watch`
 * over vue-i18n's locale ref.
 */
import { watch } from 'vue'
import { setupZodLocaleSync } from '@octabits-io/nuxt-ui-kit/zod'
import { en } from 'zod/locales'
import { DEFAULT_LOCALE, getLocale, i18n } from '~/lib/i18n'

export default defineNuxtPlugin(() => {
  setupZodLocaleSync({
    locales: { en },
    defaultLocale: DEFAULT_LOCALE,
    getLocale,
    onLocaleChange: (apply) => watch(() => i18n.global.locale.value, apply),
  })
})
