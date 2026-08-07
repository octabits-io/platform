/**
 * Client-IP trust-walk core: IP normalization and the rightmost-untrusted
 * X-Forwarded-For resolution. `./hono`'s `createClientIpMiddleware` only wires
 * this up; the semantics are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { createClientIpResolver, normalizeIp } from './client-ip';

describe('normalizeIp', () => {
  it('normalizes IPv6-mapped IPv4 to dotted-quad and lowercases IPv6', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(normalizeIp(' 10.0.0.1 ')).toBe('10.0.0.1');
  });

  it('returns null for non-IPs', () => {
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('10.0.0')).toBeNull();
    expect(normalizeIp('')).toBeNull();
  });
});


describe('createClientIpResolver (rightmost-untrusted)', () => {
  it('ignores a spoofed leftmost entry: one trusted hop returns the real client', () => {
    const resolve = createClientIpResolver(['10.0.0.1']);
    // Client sent a forged XFF ('1.2.3.4'); the trusted proxy appended the real
    // peer (203.0.113.7). Rightmost-untrusted must pick the appended entry.
    expect(resolve('10.0.0.1', '1.2.3.4, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('walks past a chain of two trusted proxies', () => {
    const resolve = createClientIpResolver(['10.0.0.1', '10.0.0.2']);
    // client → proxy2 → proxy1 (direct peer): XFF = client, proxy2
    expect(resolve('10.0.0.1', '198.51.100.9, 10.0.0.2')).toBe('198.51.100.9');
  });

  it('falls back to the direct peer on garbage XFF entries', () => {
    const resolve = createClientIpResolver(['10.0.0.1']);
    expect(resolve('10.0.0.1', 'garbage-value')).toBe('10.0.0.1');
    expect(resolve('10.0.0.1', '203.0.113.7, <script>')).toBe('10.0.0.1');
  });

  it('normalizes an IPv6-mapped direct peer for the trusted check', () => {
    const resolve = createClientIpResolver(['10.0.0.1']);
    // Peer address reported as ::ffff:10.0.0.1 must still count as trusted.
    expect(resolve('::ffff:10.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    // And IPv6-mapped candidates normalize to dotted-quad.
    expect(resolve('10.0.0.1', '::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('never honours XFF when the direct peer is untrusted', () => {
    const resolve = createClientIpResolver(['10.0.0.1']);
    expect(resolve('203.0.113.50', '1.2.3.4')).toBe('203.0.113.50');
  });

  it('returns the leftmost entry when the whole chain is trusted proxies', () => {
    const resolve = createClientIpResolver(['10.0.0.1', '10.0.0.2']);
    expect(resolve('10.0.0.1', '10.0.0.2')).toBe('10.0.0.2');
  });

  it('falls back to unknown when nothing is resolvable', () => {
    const resolve = createClientIpResolver([]);
    expect(resolve(undefined, '9.9.9.9')).toBe('unknown');
  });
});

describe('createClientIpResolver (CIDR trusted proxies)', () => {
  it('trusts a direct peer inside a CIDR range and walks past in-range hops', () => {
    const resolve = createClientIpResolver(['10.42.0.0/16']);
    // client → ingress (10.42.3.7) → app-proxy (10.42.9.1, direct peer)
    expect(resolve('10.42.9.1', '203.0.113.7, 10.42.3.7')).toBe('203.0.113.7');
  });

  it('does not trust peers outside the CIDR', () => {
    const resolve = createClientIpResolver(['10.42.0.0/16']);
    expect(resolve('10.43.0.1', '203.0.113.7')).toBe('10.43.0.1');
    // Boundary: last address inside vs first outside.
    expect(resolve('10.42.255.255', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('supports multiple ranges (private + CGNAT) and mixes with exact IPs', () => {
    const resolve = createClientIpResolver(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '203.0.113.250']);
    expect(resolve('100.64.12.34', '198.51.100.9, 192.168.1.1')).toBe('198.51.100.9');
    expect(resolve('203.0.113.250', '198.51.100.9')).toBe('198.51.100.9');
    expect(resolve('203.0.113.251', '198.51.100.9')).toBe('203.0.113.251');
  });

  it('matches IPv6 CIDRs, including v6-mapped direct peers against v4 ranges', () => {
    const resolve = createClientIpResolver(['2001:db8::/32', '10.0.0.0/8']);
    expect(resolve('2001:db8:1:2::3', '203.0.113.7')).toBe('203.0.113.7');
    expect(resolve('2001:db9::1', '203.0.113.7')).toBe('2001:db9::1');
    // Bun/Node report v4 peers as ::ffff:a.b.c.d — must match the v4 range.
    expect(resolve('::ffff:10.1.2.3', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('an IPv4 range never matches an IPv6 candidate (and vice versa)', () => {
    const resolve = createClientIpResolver(['0.0.0.0/0']);
    expect(resolve('2001:db8::1', '203.0.113.7')).toBe('2001:db8::1');
    const resolve6 = createClientIpResolver(['::/0']);
    expect(resolve6('10.0.0.1', '203.0.113.7')).toBe('10.0.0.1');
  });

  it('drops invalid CIDR entries instead of widening trust', () => {
    const resolve = createClientIpResolver(['10.0.0.0/33', 'garbage/8', '10.0.0.0/-1', '10.0.0.0/8/24']);
    expect(resolve('10.0.0.1', '203.0.113.7')).toBe('10.0.0.1');
  });
});
