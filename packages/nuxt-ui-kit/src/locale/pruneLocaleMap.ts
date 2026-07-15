import type { LocaleMap } from '@octabits-io/framework/utils';

/**
 * Drop empty-string leaves from a `LocaleMap<string>` so cleared tabs fall
 * back to the default locale instead of shadowing it with `''`. Returns a new
 * map; use `Object.keys(result).length` to decide between map and `null` when
 * the API expects `null` for "unset".
 */
export function pruneLocaleMap(map: LocaleMap<string> | null | undefined): LocaleMap<string> {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([, v]) => !!v));
}
