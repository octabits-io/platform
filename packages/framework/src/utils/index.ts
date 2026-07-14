// Slugify & URL-friendly
export { slugify, isUrlFriendly, URL_FRIENDLY_REGEX } from './slugify.ts';

// Base64
export { tryDecodeBase64 } from './base64.ts';
export type { Base64DecodeError } from './base64.ts';

// Query param normalization
export {
  normalizeQueryParamToStringOrUndefined,
  normalizeQueryParamToIntOrUndefined,
  normalizeQueryParamToArrayOrUndefined,
} from './query.ts';

// Date provider (clock-injection seam)
export { createDateProvider } from './DateProvider.ts';
export type { DateProvider } from './DateProvider.ts';

// LRU + TTL cache service
export { createLruCacheService } from './LruCacheService.ts';
export type {
  LruCache,
  LruCacheOptions,
  LruCacheService,
  LruCacheServiceDeps,
} from './LruCacheService.ts';

// Retry with exponential backoff + jitter
export { withRetry } from './retry.ts';
export type { RetryConfig, RetryOptions } from './retry.ts';

// Deep merge (i18n-overlay semantics)
export { deepMerge } from './object.ts';
export type { DeepPartial } from './object.ts';

// Strip default/empty values before persisting
export { stripDefaults } from './stripDefaults.ts';

// BCP-47 locale tags + LocaleMap resolution/negotiation
export {
  BCP47_LOCALE_REGEX,
  anyLocaleValue,
  baseLocaleOf,
  isLocaleMap,
  isLocaleMapComplete,
  localeFallbackChain,
  matchLocaleTag,
  missingLocales,
  missingLocalesInUse,
  negotiateContentLocale,
  parseAcceptLanguage,
  resolveLocale,
  resolveLocaleDeep,
  resolveLocaleOrAny,
  resolveLocaleStrict,
} from './locale.ts';
export type { Locale, LocaleMap } from './locale.ts';

// WCAG contrast helpers + Tailwind swatch palette
export { getContrastColor } from './color-contrast.ts';
export {
  TAILWIND_COLOR_HEX,
  TAILWIND_COLOR_NAMES,
  getContrastTextMode,
} from './tailwind-colors.ts';

// Fast non-cryptographic string hash (change detection)
export { hashCyrb53 } from './hashCyrb53.ts';
