/**
 * Trusted-proxy client-IP plugin.
 *
 * Resolves the real client IP, honouring `X-Forwarded-For` **only** when the direct
 * connection is a trusted proxy — otherwise the direct connection IP is used and the
 * forwarded header is ignored (so clients can't spoof their IP). Derives
 * `clientIp: string` on every request; typically used to key rate limiting.
 *
 * - `trustedProxies = ['*']` → trust all connections (network policy is the boundary)
 * - `trustedProxies = ['10.0.0.1', '10.0.0.2']` → trust specific IPs
 * - `trustedProxies = []` (default) → trust nothing, always use direct connection IP
 */
import { Elysia } from 'elysia';

export function createClientIpPlugin(trustedProxies: string[] = []) {
  const trustAll = trustedProxies.includes('*');
  const trustedSet = trustAll ? null : new Set(trustedProxies);

  return new Elysia({ name: 'client-ip' })
    .derive({ as: 'global' }, ({ request, server }) => {
      const directIp = getDirectIp(request, server);
      const isTrusted = trustAll || (directIp != null && trustedSet!.has(directIp));

      let clientIp: string;
      if (isTrusted) {
        clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || directIp
          || 'unknown';
      } else {
        clientIp = directIp || 'unknown';
      }

      return { clientIp };
    });
}

function getDirectIp(request: Request, server: unknown): string | undefined {
  const s = server as { requestIP?: (req: Request) => { address: string } | null } | null;
  return s?.requestIP?.(request)?.address;
}
