/**
 * Fixed-window counter core: window accounting, reset boundary, and the lazy
 * sweep never losing live windows. (The CIDR matcher and timing-safe compare
 * are covered through the glue-module suites.)
 */
import { describe, expect, it } from 'vitest';
import { createFixedWindowLimiter } from './rate-limit';

describe('createFixedWindowLimiter', () => {
  it('counts hits within one window and reports remaining', () => {
    const limiter = createFixedWindowLimiter({ max: 2, windowMs: 1_000 });
    expect(limiter.hit('k', 0)).toEqual({ limited: false, remaining: 1, resetAt: 1_000 });
    expect(limiter.hit('k', 100)).toEqual({ limited: false, remaining: 0, resetAt: 1_000 });
    expect(limiter.hit('k', 200)).toEqual({ limited: true, remaining: 0, resetAt: 1_000 });
  });

  it('starts a fresh window once resetAt passes', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1_000 });
    expect(limiter.hit('k', 0).limited).toBe(false);
    expect(limiter.hit('k', 999).limited).toBe(true);
    expect(limiter.hit('k', 1_000)).toEqual({ limited: false, remaining: 0, resetAt: 2_000 });
  });

  it('isolates keys', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1_000 });
    expect(limiter.hit('a', 0).limited).toBe(false);
    expect(limiter.hit('a', 1).limited).toBe(true);
    expect(limiter.hit('b', 2).limited).toBe(false);
  });

  it('limits immediately when max < 1', () => {
    const limiter = createFixedWindowLimiter({ max: 0, windowMs: 1_000 });
    expect(limiter.hit('k', 0).limited).toBe(true);
  });

  it('reset() drops all counters', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1_000 });
    limiter.hit('k', 0);
    limiter.reset();
    expect(limiter.hit('k', 1).limited).toBe(false);
  });

  it('sweeping expired windows does not disturb live ones', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1_000 });
    // Fill past the sweep threshold with keys whose windows expire at t=1000.
    for (let i = 0; i < 1_100; i++) limiter.hit(`old-${i}`, 0);
    // A live window opened late…
    expect(limiter.hit('live', 900).limited).toBe(false);
    // …survives the sweep triggered by post-expiry traffic and stays counted.
    for (let i = 0; i < 30; i++) limiter.hit(`new-${i}`, 1_500);
    expect(limiter.hit('live', 1_600).limited).toBe(true);
  });
});
