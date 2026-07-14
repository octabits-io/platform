import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DateProvider } from '../../utils/index.ts';
import type { Logger } from '../../logger/index.ts';
import { createNoopCaptchaService } from './noop';

function makeDateProvider(initialMs: number): DateProvider {
  return { now: () => new Date(initialMs) };
}

describe('NoopCaptchaService', () => {
  // Construction intentionally warns; keep test output clean.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports type "noop"', () => {
    const service = createNoopCaptchaService();
    expect(service.type).toBe('noop');
  });

  it('warns on construction via console.warn when no logger is provided', () => {
    createNoopCaptchaService();
    expect(console.warn).toHaveBeenCalledWith(
      'captcha no-op provider active — all challenges auto-pass'
    );
  });

  it('warns on construction via the provided logger instead of console', () => {
    const warn = vi.fn();
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn,
      error: () => {},
      child: () => logger,
    };

    createNoopCaptchaService({ logger });

    expect(warn).toHaveBeenCalledWith('captcha no-op provider active — all challenges auto-pass');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('createChallenge always succeeds with a far-future expiry', async () => {
    const now = 1_000_000;
    const service = createNoopCaptchaService({ dateProvider: makeDateProvider(now) });
    const result = await service.createChallenge();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expires).toBe(now + 3_600_000);
    expect(result.value.challenge).toEqual({ parameters: {} });
  });

  it('redeemChallenge always returns the fixed verified token', async () => {
    const now = 2_000_000;
    const service = createNoopCaptchaService({ dateProvider: makeDateProvider(now) });
    const result = await service.redeemChallenge('anything');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token).toBe('noop-verified-token');
    expect(result.value.expires).toBe(now + 1_200_000);
  });

  it('validateToken always succeeds', async () => {
    const service = createNoopCaptchaService();
    const result = await service.validateToken('whatever');
    expect(result.ok).toBe(true);
  });

  it('falls back to Date.now() when no dateProvider is supplied', async () => {
    const service = createNoopCaptchaService();
    const before = Date.now();
    const result = await service.createChallenge();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expires).toBeGreaterThanOrEqual(before + 3_600_000);
  });
});
