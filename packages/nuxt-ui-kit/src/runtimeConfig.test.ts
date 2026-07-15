import { afterEach, describe, expect, it } from 'vitest';
import { resolveRuntimeConfigValue } from './runtimeConfig.ts';

type WindowWithAppConfig = { __APP_CONFIG__?: Record<string, string> };

afterEach(() => {
  delete (globalThis as WindowWithAppConfig).__APP_CONFIG__;
  // @ts-expect-error test-only window stub
  delete globalThis.window;
});

function stubWindow(appConfig?: Record<string, string>) {
  // @ts-expect-error test-only window stub
  globalThis.window = appConfig ? { __APP_CONFIG__: appConfig } : {};
}

describe('resolveRuntimeConfigValue', () => {
  it('prefers the deploy-time __APP_CONFIG__ value', () => {
    stubWindow({ API_URL: 'https://api.example' });
    expect(resolveRuntimeConfigValue('API_URL', 'https://fallback')).toBe(
      'https://api.example',
    );
  });

  it('falls back when the key is absent', () => {
    stubWindow({ OTHER: 'x' });
    expect(resolveRuntimeConfigValue('API_URL', 'https://fallback')).toBe(
      'https://fallback',
    );
  });

  it('falls back when __APP_CONFIG__ is undefined', () => {
    stubWindow();
    expect(resolveRuntimeConfigValue('API_URL', 'https://fallback')).toBe(
      'https://fallback',
    );
  });

  it('treats an empty-string value as unset', () => {
    stubWindow({ API_URL: '' });
    expect(resolveRuntimeConfigValue('API_URL', 'https://fallback')).toBe(
      'https://fallback',
    );
  });

  it('returns undefined without value or fallback', () => {
    stubWindow();
    expect(resolveRuntimeConfigValue('API_URL')).toBeUndefined();
  });

  it('is SSR-safe without a window', () => {
    expect(resolveRuntimeConfigValue('API_URL', 'https://fallback')).toBe(
      'https://fallback',
    );
  });
});
