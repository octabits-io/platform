import { describe, it, expect, vi } from 'vitest';
import { createLruCacheService } from '../utils/index.ts';
import type { DateProvider } from '../utils/index.ts';

// Mock only createChallenge so we can force the underlying library to throw;
// everything else keeps the real implementation.
vi.mock('altcha-lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('altcha-lib')>();
  return {
    ...actual,
    createChallenge: vi.fn(async () => {
      throw new Error('expiration must be in the future');
    }),
  };
});

import { createAltchaCaptchaService } from './altcha';

describe('AltchaCaptchaService createChallenge failure detail', () => {
  it('surfaces the underlying error message in challenge_creation_failed', async () => {
    const dateProvider: DateProvider = { now: () => new Date() };
    const service = createAltchaCaptchaService({
      dateProvider,
      lruCacheService: createLruCacheService({ dateProvider }),
      hmacSecret: '0123456789abcdef0123456789abcdef',
      cost: 100,
    });

    const result = await service.createChallenge();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('challenge_creation_failed');
    expect(result.error.message).toContain('expiration must be in the future');
    // The secret must never leak into the error
    expect(result.error.message).not.toContain('0123456789abcdef');
  });
});
