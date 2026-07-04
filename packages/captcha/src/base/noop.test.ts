import { describe, it, expect } from 'vitest';
import type { DateProvider } from '@octabits-io/foundation/utils';
import { createNoopCaptchaService } from './noop';

function makeDateProvider(initialMs: number): DateProvider {
  return { now: () => new Date(initialMs) };
}

describe('NoopCaptchaService', () => {
  it('reports type "noop"', () => {
    const service = createNoopCaptchaService();
    expect(service.type).toBe('noop');
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
