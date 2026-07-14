/**
 * The app-side composable the kit's date engine is designed to sit under:
 * `createDateFormatter` takes a `getLocale` seam and has no i18n dependency of
 * its own, so binding it to vue-i18n is this one file.
 */
import { createDateFormatter } from '@octabits-io/nuxt-ui-kit/dates'
import { useI18n } from 'vue-i18n'

export function useDateFormat() {
  const { locale } = useI18n()
  return createDateFormatter({ getLocale: () => locale.value })
}
