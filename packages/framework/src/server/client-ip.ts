/**
 * Trusted-proxy client-IP resolution core.
 *
 * Resolves the real client IP, honouring `X-Forwarded-For` **only** when the direct
 * connection is a trusted proxy — otherwise the direct connection IP is used and the
 * forwarded header is ignored. When the direct peer IS trusted, the header is walked
 * **right-to-left** ("rightmost untrusted"): trusted-proxy hops appended by our own
 * infrastructure are skipped and the first entry that is not a trusted proxy wins.
 * The leftmost entry is client-controlled behind append-mode proxies, so it is never
 * trusted directly (except under `'*'`, where the whole chain is trusted by policy).
 * Candidates must parse as an IP (v4 or v6; `::ffff:`-mapped IPv4 is normalized to
 * dotted-quad) — garbage falls back to the direct peer.
 *
 * - `trustedProxies = ['*']` → trust all connections (network policy is the boundary;
 *   the leftmost valid entry is used)
 * - `trustedProxies = ['10.0.0.1', '10.0.0.2']` → trust specific proxy IPs
 * - `trustedProxies = ['10.0.0.0/8', '2001:db8::/32']` → trust CIDR ranges (for
 *   proxies with ephemeral addresses, e.g. Kubernetes ingress/sidecar pods)
 * - `trustedProxies = []` (default) → trust nothing, always use direct connection IP
 *
 * Invalid entries (unparseable IPs or CIDRs) are silently dropped, same as before
 * CIDR support: an operator typo narrows trust rather than widening it.
 *
 * The glue module derives `clientIp` per request from this resolver
 * (`./hono`'s `createClientIpMiddleware`); it is typically used to key rate
 * limiting.
 */
import { isIP } from 'node:net';

/**
 * Normalize an IP string for comparison: trim, lowercase, and convert
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to plain dotted-quad. Returns `null`
 * when the value does not parse as an IPv4/IPv6 address.
 */
export function normalizeIp(value: string): string | null {
  const ip = value.trim().toLowerCase();
  const version = isIP(ip);
  if (version === 0) return null;
  if (version === 6 && ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return mapped;
  }
  return ip;
}

/**
 * Convert a normalized IP to its numeric value for CIDR prefix comparison.
 * IPv4 → 32-bit, IPv6 → 128-bit (embedded-IPv4 tails like `64:ff9b::1.2.3.4`
 * included). Hand-rolled instead of `net.BlockList` on purpose: BlockList is
 * not reliably available across the runtimes this module targets (Bun).
 */
function ipToNumeric(ip: string): { value: bigint; bits: 32 | 128 } | null {
  const version = isIP(ip);
  if (version === 4) {
    const octets = ip.split('.');
    let value = 0n;
    for (const octet of octets) value = (value << 8n) | BigInt(Number(octet));
    return { value, bits: 32 };
  }
  if (version === 6) {
    // Expand `::` to the zero groups it stands for; an embedded IPv4 tail
    // counts as two 16-bit groups.
    const halves = ip.split('::');
    const parseSide = (side: string) => (side === '' ? [] : side.split(':'));
    const countGroups = (side: string[]) =>
      side.reduce((n, group) => n + (group.includes('.') ? 2 : 1), 0);
    const left = parseSide(halves[0] ?? '');
    const right = halves.length === 2 ? parseSide(halves[1] ?? '') : [];
    const fill = halves.length === 2 ? 8 - countGroups(left) - countGroups(right) : 0;
    if (fill < 0) return null;
    const groups = [...left, ...Array.from({ length: fill }, () => '0'), ...right];

    let value = 0n;
    for (const group of groups) {
      if (group.includes('.')) {
        const v4 = ipToNumeric(group);
        if (!v4) return null;
        value = (value << 32n) | v4.value;
      } else {
        value = (value << 16n) | BigInt(Number.parseInt(group, 16));
      }
    }
    return { value, bits: 128 };
  }
  return null;
}

/** Parse a `base/prefix` CIDR entry into a comparable form; null when invalid. */
function parseCidr(entry: string): { value: bigint; bits: 32 | 128; prefix: number } | null {
  const slash = entry.indexOf('/');
  if (slash === -1) return null;
  const base = normalizeIp(entry.slice(0, slash));
  const prefix = Number(entry.slice(slash + 1));
  if (base === null || !Number.isInteger(prefix) || prefix < 0) return null;
  const numeric = ipToNumeric(base);
  if (numeric === null || prefix > numeric.bits) return null;
  return { ...numeric, prefix };
}

/**
 * Build the pure client-IP resolution function:
 * `(directIp, xForwardedFor) => clientIp`.
 */
export function createClientIpResolver(trustedProxies: string[] = []) {
  const trustAll = trustedProxies.includes('*');
  const trustedSet = new Set(
    trustedProxies
      .filter((entry) => entry !== '*')
      .map((entry) => normalizeIp(entry))
      .filter((entry): entry is string => entry !== null),
  );
  const trustedCidrs = trustedProxies
    .map((entry) => parseCidr(entry))
    .filter((cidr): cidr is NonNullable<typeof cidr> => cidr !== null);
  const inTrustedCidr = (ip: string): boolean => {
    if (trustedCidrs.length === 0) return false;
    const numeric = ipToNumeric(ip);
    if (numeric === null) return false;
    return trustedCidrs.some(
      (cidr) =>
        cidr.bits === numeric.bits &&
        numeric.value >> BigInt(cidr.bits - cidr.prefix) === cidr.value >> BigInt(cidr.bits - cidr.prefix),
    );
  };
  const isTrusted = (ip: string) => trustAll || trustedSet.has(ip) || inTrustedCidr(ip);

  return (directIp: string | undefined, forwardedFor: string | null | undefined): string => {
    const direct = directIp ? normalizeIp(directIp) : null;
    const fallback = direct ?? directIp ?? 'unknown';

    const directTrusted = direct !== null ? isTrusted(direct) : trustAll;
    if (!directTrusted) return fallback;

    const entries = (forwardedFor ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length === 0) return fallback;

    if (trustAll) {
      // The whole chain is trusted by policy — the leftmost valid entry is the client.
      return normalizeIp(entries[0]!) ?? fallback;
    }

    // Rightmost-untrusted walk: skip our own trusted proxy hops from the right;
    // the first non-proxy entry is the client. Garbage → direct peer.
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = normalizeIp(entries[i]!);
      if (candidate === null) return fallback;
      if (isTrusted(candidate)) continue;
      return candidate;
    }

    // Every entry is one of our proxies — the leftmost is the true origin.
    return normalizeIp(entries[0]!) ?? fallback;
  };
}
