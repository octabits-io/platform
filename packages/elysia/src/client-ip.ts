/**
 * Trusted-proxy client-IP plugin.
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
 * Derives `clientIp: string` on every request; typically used to key rate limiting.
 *
 * - `trustedProxies = ['*']` → trust all connections (network policy is the boundary;
 *   the leftmost valid entry is used)
 * - `trustedProxies = ['10.0.0.1', '10.0.0.2']` → trust specific proxy IPs
 * - `trustedProxies = []` (default) → trust nothing, always use direct connection IP
 */
import { isIP } from 'node:net';
import { Elysia } from 'elysia';

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
 * Build the pure client-IP resolution function used by
 * {@link createClientIpPlugin}: `(directIp, xForwardedFor) => clientIp`.
 * Exposed for direct use/testing.
 */
export function createClientIpResolver(trustedProxies: string[] = []) {
  const trustAll = trustedProxies.includes('*');
  const trustedSet = new Set(
    trustedProxies
      .filter((entry) => entry !== '*')
      .map((entry) => normalizeIp(entry))
      .filter((entry): entry is string => entry !== null),
  );
  const isTrusted = (ip: string) => trustAll || trustedSet.has(ip);

  return (directIp: string | undefined, forwardedFor: string | null | undefined): string => {
    const direct = directIp ? normalizeIp(directIp) : null;
    const fallback = direct ?? directIp ?? 'unknown';

    const directTrusted = trustAll || (direct !== null && trustedSet.has(direct));
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

export function createClientIpPlugin(trustedProxies: string[] = []) {
  const resolveClientIp = createClientIpResolver(trustedProxies);

  return new Elysia({ name: 'client-ip' })
    .derive({ as: 'global' }, ({ request, server }) => {
      const directIp = getDirectIp(request, server);
      return { clientIp: resolveClientIp(directIp, request.headers.get('x-forwarded-for')) };
    });
}

function getDirectIp(request: Request, server: unknown): string | undefined {
  const s = server as { requestIP?: (req: Request) => { address: string } | null } | null;
  return s?.requestIP?.(request)?.address;
}
