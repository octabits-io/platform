/**
 * The rules behind the kit's `TranslationBadge`.
 *
 * The kit ships the badge and the `TranslationStatus` type, not the counting:
 * what counts as a translatable leaf is the app's schema. Two decisions live
 * here, and both are the kind of thing a badge gets quietly wrong:
 *
 *  - a record nobody has written a public version of has NOTHING to translate,
 *    so it gets no status at all (`undefined` → the badge hides). Reporting it
 *    "complete" would put a green check on an empty record;
 *  - register variants (`de-formal`) are not translation targets — a blank one
 *    inherits its base locale on purpose, so counting it would mark every
 *    record incomplete forever.
 */
import type { TranslationStatus } from '@octabits-io/nuxt-ui-kit/locale'
import { TRANSLATABLE_LOCALES } from '~/lib/contentLocales'

/** A sparse per-locale value map, as the kit's locale-field editors hold it. */
export type LocaleText = Record<string, string | undefined>

const hasText = (value: string | undefined) => (value ?? '').trim().length > 0

/**
 * @param fields every translatable field of one record
 * @returns `undefined` when the record has no public text at all
 */
export function translationStatusOf(
  fields: readonly (LocaleText | null | undefined)[],
  locales: readonly string[] = TRANSLATABLE_LOCALES,
): TranslationStatus | undefined {
  const inUse = fields.filter((field) => Object.values(field ?? {}).some(hasText))
  if (!inUse.length) return undefined

  const missing: Record<string, number> = {}
  for (const locale of locales) {
    const gaps = inUse.filter((field) => !hasText(field![locale])).length
    if (gaps > 0) missing[locale] = gaps
  }
  return { complete: Object.keys(missing).length === 0, missing }
}
