/**
 * Trusted-proxy client-IP plugin: derives `clientIp: string` on every request
 * from the framework-neutral resolver in `../server/client-ip` (see there for
 * the trust-walk semantics); typically used to key rate limiting. The direct
 * connection IP comes from Bun's `server.requestIP()`.
 *
 * `normalizeIp` and `createClientIpResolver` are re-exported for backwards
 * compatibility.
 */
import { Elysia } from 'elysia';
import { createClientIpResolver, normalizeIp } from '../server/client-ip';

export { createClientIpResolver, normalizeIp };

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
