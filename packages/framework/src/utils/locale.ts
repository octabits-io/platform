/** BCP-47 locale tag (e.g. "en", "de", "de-formal", "fr-CA"). */
export type Locale = string;

/** Map from locale tag to value. Sparse — only present locales have a value. */
export type LocaleMap<T = string> = { [locale: string]: T | undefined };

/**
 * BCP-47 simplified: language[-Script][-REGION][-variant].
 * Accepts "en", "de", "de-formal", "fr-CA", "zh-Hans", "zh-Hans-CN",
 * "es-419", "en-001" (UN M49 numeric regions), "de-CH-1901" (numeric-leading
 * variants), etc.
 *
 * Subtag rules:
 * - language: `[a-z]{2,3}` — DELIBERATELY lowercase-only. We do NOT accept an
 *   uppercase language subtag (`DE`): LocaleMap keys are case-sensitive object
 *   keys, so allowing both `de` and `DE` would create map-key-casing chaos.
 *   Case-insensitive *matching* happens at lookup time (see resolveLocale /
 *   matchLocaleTag), not by widening what counts as a valid tag.
 * - region: two uppercase letters (`AT`) OR a UN M49 three-digit code (`419`).
 * - variant: the pragmatic register form `[a-z][a-z0-9]+` (e.g. `formal`) OR a
 *   BCP-47 variant — 5–8 alphanumerics, or a 4-char run led by a digit (`1901`).
 */
export const BCP47_LOCALE_REGEX =
  /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?(-([a-z][a-z0-9]+|[0-9][a-z0-9]{3}|[a-z0-9]{5,8}))?$/;

/**
 * Primary language subtag of a BCP-47 tag — the base a register/region variant
 * falls back to: `de-formal` → `de`, `de-DE` → `de`, `fr-CA` → `fr`, `de` → `de`.
 *
 * This is the *content-resolution* analog of a routing-only base collapse
 * (`de-formal → de` for URLs). Use this for LocaleMap fallback; do not conflate
 * the two.
 */
export function baseLocaleOf(locale: Locale): Locale {
  return locale.toLowerCase().split('-')[0]!;
}

/**
 * Ordered, de-duplicated fallback chain for resolving a LocaleMap value:
 * requested locale → its base language → default locale → default's base.
 *
 * Formal/informal German is a register *overlay*, not a sibling locale: a
 * `de-formal` request with only a `de` value in the map resolves to the `de`
 * value (the polite chrome lives in the UI bundle, not in content). This chain
 * encodes that — `de-formal → de → <default>`.
 */
export function localeFallbackChain(locale: Locale, defaultLocale: Locale): Locale[] {
  return [
    ...new Set([locale, baseLocaleOf(locale), defaultLocale, baseLocaleOf(defaultLocale)]),
  ];
}

/**
 * Resolve a LocaleMap to a single value, walking the {@link localeFallbackChain}
 * (requested → base language → default → default's base) and returning the first
 * present value. Returns undefined only if no chain entry has a value.
 *
 * Present-key (`!= null`) semantics: an explicitly stored value wins at its step
 * even if empty, so an emptied register override must *delete* its key (not store
 * `''`) to fall through to the base locale.
 *
 * Casing: negotiation/matching are case-insensitive (`de-AT`), but map keys are
 * case-sensitive object keys (possibly stored `de-at`). The hot path is an exact
 * key hit; only on a full miss do we build a lowercased key view once and retry
 * each fallback-chain entry case-insensitively.
 */
export function resolveLocale<T>(
  map: LocaleMap<T> | null | undefined,
  locale: Locale,
  defaultLocale: Locale,
): T | undefined {
  if (!map) return undefined;
  // Lowercased-key view, built lazily on the first exact miss and reused for the
  // rest of the chain. Prefers keys that carry a non-empty value on collision.
  let lowerKeys: Map<string, string> | undefined;
  const buildLowerKeys = () => {
    const view = new Map<string, string>();
    for (const key of Object.keys(map)) {
      const lk = key.toLowerCase();
      if (!view.has(lk) || map[view.get(lk)!] == null) view.set(lk, key);
    }
    return view;
  };
  for (const loc of localeFallbackChain(locale, defaultLocale)) {
    // Hot path: exact key match, preserving request casing.
    if (map[loc] != null) return map[loc];
    // Per-entry case-insensitive fallback (map keyed `de-at`, tag `de-AT`) —
    // this wins over the next chain entry (the base language / default).
    lowerKeys ??= buildLowerKeys();
    const original = lowerKeys.get(loc.toLowerCase());
    if (original != null && map[original] != null) return map[original];
  }
  return undefined;
}

/**
 * Strict variant: throws if neither locale nor default is present.
 * Use in back-office flows where a missing translation indicates a data bug.
 */
export function resolveLocaleStrict<T>(
  map: LocaleMap<T>,
  locale: Locale,
  defaultLocale: Locale,
): T {
  const value = resolveLocale(map, locale, defaultLocale);
  if (value === undefined) {
    throw new Error(
      `LocaleMap missing both '${locale}' and default '${defaultLocale}'`,
    );
  }
  return value;
}

/**
 * Best-effort single value from a LocaleMap for contexts that do not (yet) carry
 * a resolved request locale — prefers `preferred`, then `en`, then the remaining
 * locales in sorted order (deterministic; never object/JSONB insertion order).
 *
 * This is a deliberate stopgap for non-localized read paths (AI prompts,
 * embeddings, seeds, internal snapshots). Display reads that know the configured
 * default locale should use {@link resolveLocaleOrAny}; user-facing reads should
 * resolve via the request locale rather than calling this.
 */
export function anyLocaleValue<T>(
  map: LocaleMap<T> | null | undefined,
  preferred?: Locale,
): T | undefined {
  if (!map) return undefined;
  if (preferred && map[preferred] != null) return map[preferred];
  // Deterministic tail: prefer English, then sorted key order — never the
  // JSONB/object insertion order, which is not a stable locale choice.
  if (map.en != null) return map.en;
  for (const key of Object.keys(map).sort()) {
    if (map[key] != null) return map[key];
  }
  return undefined;
}

/**
 * Resolve a LocaleMap via the {@link localeFallbackChain}, then fall back to
 * any present translation ({@link anyLocaleValue}). For display, snapshot, and
 * mail contexts where *some* translation beats rendering nothing.
 *
 * `defaultLocale` defaults to `locale`, covering the common shapes
 * `resolveLocaleOrAny(map, defaultLocale)` (back-office display) and
 * `resolveLocaleOrAny(map, mailLocale)` (notifications). Public-site reads
 * should keep using {@link resolveLocale} with the negotiated request locale
 * so missing translations stay visible.
 */
export function resolveLocaleOrAny<T>(
  map: LocaleMap<T> | null | undefined,
  locale: Locale,
  defaultLocale: Locale = locale,
): T | undefined {
  return resolveLocale(map, locale, defaultLocale) ?? anyLocaleValue(map);
}

/**
 * Match a single locale tag against a list of supported tags: exact match first,
 * then by base language. Lets a route/URL locale (`de`) select the supported
 * content locale even when that is a variant (`de-formal`).
 * Returns undefined when nothing matches.
 */
export function matchLocaleTag(
  tag: Locale | null | undefined,
  supported: readonly Locale[],
): Locale | undefined {
  if (!tag) return undefined;
  const lower = tag.toLowerCase();
  const exact = supported.find((s) => s.toLowerCase() === lower);
  if (exact) return exact;
  const base = baseLocaleOf(lower);
  return supported.find((s) => baseLocaleOf(s.toLowerCase()) === base);
}

/**
 * Parse an `Accept-Language` header into locale tags ordered by descending
 * quality weight. Drops the wildcard `*`, blank tags, and entries explicitly
 * marked not-acceptable (`q=0`). Quality defaults to `1` when absent or
 * unparseable (RFC 7231), and is clamped to the valid `[0,1]` range.
 */
export function parseAcceptLanguage(header: string | null | undefined): Locale[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      const parsed = q ? parseFloat(q.split('=')[1] ?? '') : 1;
      // Missing/malformed q → 1; clamp out-of-range values into [0,1].
      const quality = Number.isNaN(parsed) ? 1 : Math.min(1, Math.max(0, parsed));
      return { tag: (tag ?? '').trim(), quality };
    })
    .filter((r) => r.tag && r.tag !== '*' && r.quality > 0)
    .sort((a, b) => b.quality - a.quality)
    .map((r) => r.tag);
}

/**
 * Resolve the effective content locale for a public-facing request.
 *
 * Priority: an explicit `hint` (a route/URL locale) → the `Accept-Language`
 * header → the configured `defaultLocale`. Every candidate is matched against
 * `supported` via {@link matchLocaleTag} (exact tag, then base language), so a
 * route `de` selects a deployment whose German content is stored under
 * `de-formal`. The returned value is always one of `supported` (or
 * `defaultLocale` as the guaranteed fallback).
 */
export function negotiateContentLocale(params: {
  hint?: Locale | null;
  acceptLanguage?: string | null;
  supported: readonly Locale[];
  defaultLocale: Locale;
}): Locale {
  const { hint, acceptLanguage, supported, defaultLocale } = params;
  const fromHint = matchLocaleTag(hint, supported);
  if (fromHint) return fromHint;
  for (const tag of parseAcceptLanguage(acceptLanguage)) {
    const matched = matchLocaleTag(tag, supported);
    if (matched) return matched;
  }
  return defaultLocale;
}

/**
 * Has every supported locale got a non-empty string value? Whitespace-only
 * values count as missing (trim before checking, matching typical
 * required-default-locale validation).
 */
export function isLocaleMapComplete(
  map: LocaleMap<string>,
  supportedLocales: readonly Locale[],
): boolean {
  return supportedLocales.every(
    (loc) => typeof map[loc] === 'string' && map[loc]!.trim().length > 0,
  );
}

/**
 * Which supported locales are missing or empty in the map? Whitespace-only
 * values count as missing.
 */
export function missingLocales(
  map: LocaleMap<string>,
  supportedLocales: readonly Locale[],
): Locale[] {
  return supportedLocales.filter(
    (loc) => !map[loc] || map[loc]!.trim().length === 0,
  );
}

/**
 * Like {@link missingLocales}, but with translation-completeness badge
 * semantics: a leaf only counts when it is *in use* (≥1 non-empty value in any
 * locale), and register variants (`de-formal`) inherit their base locale — a
 * variant is only missing when the base is missing too. Works for non-string
 * leaves (e.g. rich-text editor content).
 */
export function missingLocalesInUse(
  map: LocaleMap<unknown> | null | undefined,
  supportedLocales: readonly Locale[],
): Locale[] {
  if (!map) return [];
  const hasValue = (v: unknown) => v !== undefined && v !== null && v !== '';
  if (!Object.values(map).some(hasValue)) return [];
  return supportedLocales.filter(
    (loc) => !hasValue(map[loc]) && !hasValue(map[baseLocaleOf(loc)]),
  );
}

/**
 * Heuristic LocaleMap discriminator: every key matches BCP-47, the object
 * has at least one key, and every value is the same primitive type.
 * Used by resolveLocaleDeep to detect locale-map leaves in ad-hoc payloads.
 * Schema-driven resolution should be preferred where the schema is known.
 */
export function isLocaleMap(value: unknown): value is LocaleMap<unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;

  let firstType: string | undefined;
  for (const [key, v] of entries) {
    if (!BCP47_LOCALE_REGEX.test(key)) return false;
    if (v === undefined) continue;
    const t = typeof v;
    if (t === 'object') return false;
    if (firstType === undefined) firstType = t;
    else if (firstType !== t) return false;
  }
  return true;
}

/**
 * Recursively walk a value, replacing every nested LocaleMap leaf with its
 * resolved value for the given locale. Non-LocaleMap objects/arrays are
 * traversed; primitives pass through unchanged. Returns unknown because
 * the type structure is transformed at runtime.
 */
export function resolveLocaleDeep(
  value: unknown,
  locale: Locale,
  defaultLocale: Locale,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isLocaleMap(value)) {
    return resolveLocale(value as LocaleMap<unknown>, locale, defaultLocale);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveLocaleDeep(v, locale, defaultLocale));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = resolveLocaleDeep(v, locale, defaultLocale);
  }
  return out;
}
