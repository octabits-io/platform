import { describe, it, expect, vi } from 'vitest';

import { withRetry } from './retry.ts';

const fastConfig = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 5,
  backoffMultiplier: 2,
} as const;

describe('withRetry', () => {
  it('returns the result on first success without retrying', async () => {
    const op = vi.fn(async () => 'ok');
    const result = await withRetry(op, 'op', undefined, undefined, { config: fastConfig });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries until success', async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return 'recovered';
    });
    const result = await withRetry(op, 'op', undefined, undefined, { config: fastConfig });
    expect(result).toBe('recovered');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting maxAttempts', async () => {
    const op = vi.fn(async () => {
      throw new Error('always fails');
    });
    await expect(
      withRetry(op, 'op', undefined, undefined, { config: fastConfig })
    ).rejects.toThrow('always fails');
    expect(op).toHaveBeenCalledTimes(fastConfig.maxAttempts);
  });

  it('does not retry when the error is classified non-retryable', async () => {
    const op = vi.fn(async () => {
      throw new Error('fatal');
    });
    await expect(
      withRetry(op, 'op', () => false, undefined, { config: fastConfig })
    ).rejects.toThrow('fatal');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('logs a warning on each retry when a logger is injected', async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() };
    let attempts = 0;
    const op = async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return 'ok';
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(op, 'op', undefined, { requestId: 'r1' }, { config: fastConfig, logger: logger as any });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Operation failed, retrying',
      expect.objectContaining({ operationName: 'op', attempt: 1, requestId: 'r1' })
    );
  });
});
