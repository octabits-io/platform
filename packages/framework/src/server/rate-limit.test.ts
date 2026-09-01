/**
 * Fixed-window counter core: window accounting, reset boundary, and the lazy
 * sweep never losing live windows, plus the IPv4-CIDR/exact-IP skip matcher.
 */
import { describe, expect, it } from 'vitest';
import { createCidrMatcher, createFixedWindowLimiter, timingSafeStringEqual } from './rate-limit';

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

describe('createCidrMatcher', () => {
  it('matches IPv4 CIDR ranges (/8, /24, /32) and rejects outsiders', () => {
    const match = createCidrMatcher(['10.0.0.0/8', '192.168.1.0/24', '203.0.113.7/32']);
    expect(match('10.255.1.2')).toBe(true);        // inside /8
    expect(match('11.0.0.1')).toBe(false);         // just outside /8
    expect(match('192.168.1.200')).toBe(true);     // inside /24
    expect(match('192.168.2.1')).toBe(false);      // outside /24
    expect(match('203.0.113.7')).toBe(true);       // exact /32
    expect(match('203.0.113.8')).toBe(false);      // /32 excludes neighbors
  });

  it('does not string-prefix match (the old bug)', () => {
    const match = createCidrMatcher(['10.0.0.0/24']);
    // '10.0.0.' string-prefix would wrongly match 10.0.0.99 AND '10.0.01.1'-style
    // lookalikes; real CIDR math must exclude 10.0.1.x.
    expect(match('10.0.0.99')).toBe(true);
    expect(match('10.0.1.1')).toBe(false);
  });

  it('normalizes IPv6-mapped IPv4 keys before matching', () => {
    const match = createCidrMatcher(['10.0.0.0/24']);
    expect(match('::ffff:10.0.0.5')).toBe(true);
    expect(match('::ffff:10.0.1.5')).toBe(false);
  });

  it('supports bare IPs (IPv4 and IPv6) as exact matches', () => {
    const match = createCidrMatcher(['203.0.113.7', '2001:db8::1']);
    expect(match('203.0.113.7')).toBe(true);
    expect(match('203.0.113.8')).toBe(false);
    expect(match('2001:db8::1')).toBe(true);
    expect(match('2001:DB8::1')).toBe(true); // case-insensitive
    expect(match('2001:db8::2')).toBe(false);
  });

  it('never matches garbage keys', () => {
    const match = createCidrMatcher(['10.0.0.0/8']);
    expect(match('not-an-ip')).toBe(false);
    expect(match('')).toBe(false);
  });

  it('throws on invalid entries at construction', () => {
    expect(() => createCidrMatcher(['10.0.0.'])).toThrow(/Invalid skipCidrs entry/);
    expect(() => createCidrMatcher(['10.0.0.0/33'])).toThrow(/Invalid skipCidrs entry/);
    expect(() => createCidrMatcher(['fd00::/8'])).toThrow(/Invalid skipCidrs entry/); // IPv6 CIDR unsupported
  });
});

/**
 * The comparison behind bypass-token checks. `timingSafeEqual` throws on
 * mismatched lengths, so the length guard is not an optimisation — without it
 * a short guess crashes the request instead of being rejected.
 */
describe('timingSafeStringEqual', () => {
  it('matches identical strings', () => {
    expect(timingSafeStringEqual('s3cret-token', 's3cret-token')).toBe(true);
    expect(timingSafeStringEqual('', '')).toBe(true);
  });

  it('rejects same-length differences', () => {
    expect(timingSafeStringEqual('s3cret-token', 's3cret-tokeN')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(timingSafeStringEqual('s3cret', 's3cret-token')).toBe(false);
    expect(timingSafeStringEqual('', 'x')).toBe(false);
  });

  it('compares bytes, not code units — multi-byte input is handled', () => {
    expect(timingSafeStringEqual('tökén', 'tökén')).toBe(true);
    // Same character count, different bytes.
    expect(timingSafeStringEqual('tökén', 'token')).toBe(false);
  });
});
