/**
 * Strip empty / default values from an object before emitting it.
 *
 * Useful when persisting form/config JSON that should stay minimal — defaults
 * are implied, only overrides are stored.
 *
 * Rules:
 * - Empty string, null, undefined → omitted
 * - Empty array → omitted
 * - Value `===` the corresponding default → omitted (reference equality only;
 *   callers pass a stable `defaults` object)
 * - Keys listed in `alwaysEmit` are kept regardless (e.g. required fields
 *   that must round-trip even when empty during authoring)
 */
export function stripDefaults<T extends Record<string, unknown>>(
  state: T,
  defaults: T,
  options?: { alwaysEmit?: readonly (keyof T)[] },
): Record<string, unknown> {
  const alwaysEmit = new Set<keyof T>(options?.alwaysEmit ?? []);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(state) as (keyof T)[]) {
    const value = state[key];
    if (alwaysEmit.has(key)) {
      out[key as string] = value;
      continue;
    }
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value === defaults[key]) continue;
    out[key as string] = value;
  }
  return out;
}
