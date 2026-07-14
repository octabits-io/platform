import * as z from 'zod';

type ZodLocaleFactory = () => Parameters<typeof z.config>[0];

export interface ZodLocaleSyncOptions {
  /** Locale code → zod locale factory (from `zod/locales`), e.g. `{ de, en }`. */
  locales: Record<string, ZodLocaleFactory>;
  /** Applied when the active locale has no entry in `locales`. */
  defaultLocale: string;
  /** Read the active UI locale code. */
  getLocale: () => string;
  /**
   * Wire locale-change reactivity — call `apply` with the new code whenever
   * the UI locale changes (e.g. `apply => watch(() => i18n.locale.value, apply)`).
   */
  onLocaleChange: (apply: (code: string) => void) => void;
}

/**
 * Keep Zod's built-in error messages in the user's language: applies the
 * matching `zod/locales` config immediately and re-applies on every locale
 * change. Call once from an app plugin.
 */
export function setupZodLocaleSync(options: ZodLocaleSyncOptions): void {
  const apply = (code: string) => {
    const factory = options.locales[code] ?? options.locales[options.defaultLocale];
    if (factory) z.config(factory());
  };
  apply(options.getLocale());
  options.onLocaleChange(apply);
}
