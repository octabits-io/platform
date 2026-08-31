import type { LocaleMap } from '@octabits-io/framework/utils';

/**
 * Drop empty-string leaves from a `LocaleMap<string>` so cleared tabs fall
 * back to the default locale instead of shadowing it with `''`. Returns a new
 * map; use `Object.keys(result).length` to decide between map and `null` when
 * the API expects `null` for "unset".
 *
 * The return is **dense** — `Record<string, string>`, not `LocaleMap<string>`.
 * Emptiness is exactly what this function removes, so handing back the sparse
 * type would have made every caller cast: an API whose request body is
 * `Record<string, string>` (the usual shape a validator infers) rejects a map
 * whose values are `string | undefined`, which is the one place a pruned map
 * is guaranteed not to be. Assigning the result back to a `LocaleMap<string>`
 * stays legal in that direction.
 */
export function pruneLocaleMap(map: LocaleMap<string> | null | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map ?? {}).filter((entry): entry is [string, string] => !!entry[1]),
  );
}
