import { describe, it, expect } from 'vitest';

import { createDateProvider } from './DateProvider.ts';

describe('createDateProvider', () => {
  it('returns a Date instance from now()', () => {
    const provider = createDateProvider();
    expect(provider.now()).toBeInstanceOf(Date);
  });

  it('returns the current time (within a small tolerance)', () => {
    const provider = createDateProvider();
    const before = Date.now();
    const now = provider.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('returns a fresh Date on each call', () => {
    const provider = createDateProvider();
    const a = provider.now();
    const b = provider.now();
    expect(a).not.toBe(b);
  });
});
