/**
 * Runtime-config lookup for SPAs deployed behind a static file server: an
 * entrypoint script may define `window.__APP_CONFIG__` (values injected at
 * deploy time), which takes precedence over the build-time fallback (e.g.
 * Nuxt `runtimeConfig.public.*`).
 */
export function resolveRuntimeConfigValue(
  appConfigKey: string,
  fallback: string,
): string;
export function resolveRuntimeConfigValue(
  appConfigKey: string,
  fallback?: string,
): string | undefined;
export function resolveRuntimeConfigValue(
  appConfigKey: string,
  fallback?: string,
): string | undefined {
  const appConfig =
    typeof window === 'undefined'
      ? undefined
      : (window as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__;
  return appConfig?.[appConfigKey] || fallback;
}
