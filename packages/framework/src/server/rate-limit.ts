/**
 * Framework-neutral rate-limiting cores shared by the glue modules: the
 * IPv4-CIDR/exact-IP skip matcher, timing-safe string comparison, and a plain
 * fixed-window counter. `./elysia`'s `createRateLimit` wraps the
 * `elysia-rate-limit` vendor around the matcher; `./hono`'s rate-limit
 * middleware is built entirely from these cores.
 */
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { normalizeIp } from './client-ip';

function ipv4ToInt(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.').map(Number);
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

interface Ipv4Range {
  base: number;
  mask: number;
}

/**
 * Build an IP matcher from `skipCidrs` entries: IPv4 CIDR (`a.b.c.d/nn`) and
 * bare IPv4/IPv6 addresses (exact match). Throws on invalid entries.
 */
export function createCidrMatcher(entries: string[]): (ip: string) => boolean {
  const ranges: Ipv4Range[] = [];
  const exact = new Set<string>();

  for (const entry of entries) {
    const trimmed = entry.trim();
    const slash = trimmed.indexOf('/');
    if (slash >= 0) {
      const base = normalizeIp(trimmed.slice(0, slash));
      const bits = Number(trimmed.slice(slash + 1));
      const baseInt = base === null ? null : ipv4ToInt(base);
      if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        throw new Error(`Invalid skipCidrs entry "${entry}" — expected IPv4 CIDR (a.b.c.d/nn) or a bare IP address`);
      }
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      ranges.push({ base: (baseInt & mask) >>> 0, mask });
      continue;
    }
    const normalized = normalizeIp(trimmed);
    if (normalized === null) {
      throw new Error(`Invalid skipCidrs entry "${entry}" — expected IPv4 CIDR (a.b.c.d/nn) or a bare IP address`);
    }
    exact.add(normalized);
  }

  return (ip: string): boolean => {
    const normalized = normalizeIp(ip);
    if (normalized === null) return false;
    if (exact.has(normalized)) return true;
    const asInt = ipv4ToInt(normalized);
    if (asInt === null) return false;
    return ranges.some((range) => ((asInt & range.mask) >>> 0) === range.base);
  };
}

/** Constant-time string comparison (length mismatch short-circuits). */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** One {@link createFixedWindowLimiter} decision. */
export interface FixedWindowHit {
  /** Whether this request exceeds the limit and should be rejected. */
  limited: boolean;
  /** Requests left in the current window AFTER this one (0 when limited). */
  remaining: number;
  /** Epoch ms at which the current window resets. */
  resetAt: number;
}

export interface FixedWindowLimiterOptions {
  /** Maximum number of requests allowed per key within the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Plain in-memory fixed-window counter: `hit(key)` counts a request against
 * the key's current window and reports whether it is over the limit.
 *
 * Per-process state (a Map) — matching what `elysia-rate-limit`'s default
 * store did. Expired windows are pruned lazily on hit and in bulk whenever
 * the map grows past a sweep threshold, so idle keys don't accumulate.
 */
export function createFixedWindowLimiter(options: FixedWindowLimiterOptions) {
  const { max, windowMs } = options;
  const windows = new Map<string, { count: number; resetAt: number }>();
  // Sweep opportunistically once the map is 4× the number of keys a single
  // window could legitimately hold no bound on — cheap heuristic, avoids a timer.
  let sweepAt = 1024;

  const sweep = (now: number) => {
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
    sweepAt = Math.max(1024, windows.size * 2);
  };

  return {
    hit(key: string, now = Date.now()): FixedWindowHit {
      if (windows.size >= sweepAt) sweep(now);

      const existing = windows.get(key);
      if (!existing || existing.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return { limited: max < 1, remaining: Math.max(0, max - 1), resetAt: now + windowMs };
      }

      existing.count += 1;
      return {
        limited: existing.count > max,
        remaining: Math.max(0, max - existing.count),
        resetAt: existing.resetAt,
      };
    },
    /** Test/ops hook: drop all counters. */
    reset(): void {
      windows.clear();
    },
  };
}
