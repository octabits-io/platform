import { timingSafeEqual } from 'node:crypto';
import type { createRemoteJWKSet, JWTPayload } from 'jose';
import { err, ok } from '../result/index.ts';
import type { Logger } from '../logger/types.ts';
import { extractBearerToken } from './BearerAuthService.ts';

/** JWT validation error taxonomy (domain-agnostic). */
export type JwtValidationError =
  | { key: 'missing_token'; message: string }
  | { key: 'invalid_token'; message: string }
  | { key: 'expired_token'; message: string }
  | { key: 'missing_claims'; message: string }
  | { key: 'jwks_unavailable'; message: string };

/**
 * Result of mapping a verified JWT payload to the caller's domain token shape.
 *
 * Return `{ ok: true, value }` with the mapped token, or `{ ok: false, message }`
 * to surface a `missing_claims` validation error with a caller-controlled message.
 */
export type ClaimMapperResult<TToken> =
  | { ok: true; value: TToken }
  | { ok: false; message: string };

/**
 * Maps a verified (signature/issuer/audience-checked) JWT payload to the
 * caller's domain token shape. All provider-specific claim-key knowledge
 * (e.g. Zitadel namespaces) lives here, in the consumer.
 */
export type ClaimMapper<TToken> = (payload: JWTPayload) => ClaimMapperResult<TToken>;

/** Result of a token validation attempt. */
export type ValidateResult<TToken> =
  | { ok: true; value: TToken }
  | { ok: false; error: JwtValidationError };

/** The generic JWT validation service surface. */
export interface JwtValidationService<TToken> {
  /** Validate a raw JWT string. */
  validateToken(token: string): Promise<ValidateResult<TToken>>;
  /** Validate a JWT from an `Authorization` header value. */
  validateAuthorizationHeader(
    authorizationHeader: string | undefined,
  ): Promise<ValidateResult<TToken>>;
  /** Extract the Bearer token from an `Authorization` header value. */
  extractBearerToken(authorizationHeader: string | undefined): string | null;
}

/** Configuration for the generic JWT validation service. */
export interface JwtValidationServiceConfig<TToken> {
  /** OIDC issuer URL (e.g., https://auth.example.com) */
  issuerUrl: string;
  /** Expected JWT audience (e.g. the OIDC project/client id) */
  audience: string;
  /** Logger instance */
  logger: Logger;
  /**
   * Maps a verified JWT payload to the caller's domain token shape.
   * Provider-specific claim extraction is fully delegated here.
   */
  claimMapper: ClaimMapper<TToken>;
  /**
   * Accepted JWS algorithms, passed to jose's `jwtVerify`. Defaults to the
   * asymmetric algorithm families (RS/PS/ES/EdDSA) — JWKS-based OIDC
   * validation never uses HMAC keys, and pinning prevents algorithm-confusion.
   */
  algorithms?: string[];
  /**
   * Secret token for E2E test auth bypass. When set, requests bearing this
   * exact token skip JWKS validation and receive the caller-supplied
   * `bypassToken`. MUST NEVER be effective in production (neutralized below).
   */
  authBypassSecret?: string;
  /**
   * Synthetic domain token returned when the auth-bypass secret matches.
   * Required for the bypass path to activate; construct it in the consumer
   * (the synthetic identity is domain-specific).
   */
  bypassToken?: TToken;
}

/** Sentinel error to distinguish OIDC discovery failures from JWT validation errors */
class OidcDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OidcDiscoveryError';
  }
}

/** Cooldown period after an OIDC discovery failure (30 seconds) */
const DISCOVERY_COOLDOWN_MS = 30_000;

/**
 * Default accepted JWS algorithms: the asymmetric families. Symmetric (HS*)
 * algorithms are excluded — they are meaningless against a public JWKS and
 * enable key-confusion attacks when accepted.
 */
const DEFAULT_JWT_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
];

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

/**
 * jose signals expiry with `code: 'ERR_JWT_EXPIRED'`. The message fallback
 * matches only jose's exact expiry wording — a loose `includes('exp')` would
 * also match e.g. `unexpected "iss" claim value` and misreport wrong-issuer
 * tokens as expired.
 */
function isJwtExpiredError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === 'ERR_JWT_EXPIRED') return true;
  return error instanceof Error && error.message.includes('"exp" claim timestamp check failed');
}

/** Length-guarded constant-time string comparison. */
function secureEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

/**
 * Creates a JWT validation service that verifies OIDC-issued JWTs.
 *
 * Lazily fetches the JWKS URI from the issuer's OIDC discovery document on
 * first token validation, then uses jose's createRemoteJWKSet for signature
 * verification with automatic caching and key rotation. Verified payloads are
 * handed to the injected `claimMapper` to produce the domain token shape.
 *
 * `jose` is an optional peer, loaded lazily on first validation — creating the
 * service (and the rest of the `./auth` surface) works without it installed.
 */
export function createJwtValidationService<TToken>({
  issuerUrl,
  audience,
  logger,
  claimMapper,
  algorithms = DEFAULT_JWT_ALGORITHMS,
  authBypassSecret,
  bypassToken,
}: JwtValidationServiceConfig<TToken>): JwtValidationService<TToken> {
  // Remove trailing slash from issuer URL
  const issuer = issuerUrl.replace(/\/$/, '');

  // JWKS initialized lazily on first token validation
  let jwks: RemoteJwks | null = null;
  let jwksInitPromise: Promise<RemoteJwks> | null = null;
  let lastDiscoveryFailureAt = 0;

  async function getJwks(): Promise<RemoteJwks> {
    if (jwks) return jwks;

    // Cooldown: reject immediately if we failed recently
    const elapsed = Date.now() - lastDiscoveryFailureAt;
    if (lastDiscoveryFailureAt > 0 && elapsed < DISCOVERY_COOLDOWN_MS) {
      throw new OidcDiscoveryError(
        `OIDC discovery cooldown active (${Math.ceil((DISCOVERY_COOLDOWN_MS - elapsed) / 1000)}s remaining)`,
      );
    }

    if (!jwksInitPromise) {
      jwksInitPromise = (async () => {
        // Lazy jose load — already resolved by validateToken's own import, so
        // this only reads the module cache.
        const { createRemoteJWKSet: createJwkSet } = await import('jose');
        const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
        try {
          const res = await fetch(discoveryUrl);
          if (!res.ok) {
            throw new Error(`OIDC discovery returned HTTP ${res.status}`);
          }
          const discovery = (await res.json()) as { jwks_uri?: string };
          if (!discovery.jwks_uri) {
            throw new Error(`OIDC discovery response missing jwks_uri field`);
          }
          logger.info('JWKS URI resolved from OIDC discovery', { jwksUri: discovery.jwks_uri });
          lastDiscoveryFailureAt = 0;
          jwks = createJwkSet(new URL(discovery.jwks_uri));
          return jwks;
        } catch (err) {
          lastDiscoveryFailureAt = Date.now();
          jwksInitPromise = null; // Clear poison promise so next caller retries
          throw new OidcDiscoveryError(
            `OIDC discovery failed for ${issuer}`,
            { cause: err },
          );
        }
      })();
    }
    return jwksInitPromise;
  }

  logger.info('JWT validation service initialized', { issuer, audience });

  // Belt-and-braces: even if config somehow carried AUTH_BYPASS_SECRET into a production
  // process, neutralize it here so the bypass code path below is dead in prod.
  const productionEnv = process.env.NODE_ENV === 'production' || process.env.PRODUCTION === 'true';
  const effectiveBypassSecret = productionEnv ? undefined : authBypassSecret;
  if (authBypassSecret && productionEnv) {
    logger.error('AUTH_BYPASS_SECRET was provided to the JWT validation service in a production process — ignoring. This is a misconfiguration and must be removed from the environment.');
  } else if (effectiveBypassSecret) {
    logger.warn('AUTH BYPASS SECRET IS SET — JWT validation can be skipped with the bypass token. This must NEVER be enabled in production.');
  }

  /**
   * Validate a JWT and extract the validated token.
   */
  async function validateToken(token: string): Promise<ValidateResult<TToken>> {
    // E2E test bypass: if the token matches the bypass secret, return the synthetic
    // identity without contacting the OIDC provider. Dead code when the bypass secret
    // is unset, and hard-neutralized in production processes (see effectiveBypassSecret).
    if (effectiveBypassSecret && secureEquals(token, effectiveBypassSecret)) {
      if (bypassToken === undefined) {
        logger.error('Auth bypass secret matched but no bypassToken was configured — rejecting.');
        return err({ key: 'invalid_token', message: 'Auth bypass not configured' });
      }
      logger.warn('Auth bypass active — using synthetic token for E2E testing');
      return ok(bypassToken);
    }

    // jose is an optional peer, loaded lazily. A missing install is a
    // deployment/programming error and throws (outside the Result contract).
    const { jwtVerify } = await import('jose');

    try {
      const resolvedJwks = await getJwks();
      const { payload } = await jwtVerify(token, resolvedJwks, {
        issuer,
        audience,
        algorithms,
      });

      const mapped = claimMapper(payload);
      if (!mapped.ok) {
        return err({ key: 'missing_claims', message: mapped.message });
      }

      return ok(mapped.value);
    } catch (error) {
      if (error instanceof OidcDiscoveryError) {
        logger.warn('OIDC discovery unavailable — cannot validate JWT', {
          issuer,
          error: error.cause instanceof Error ? error.cause.message : error.message,
        });
        return err({ key: 'jwks_unavailable', message: 'Auth provider temporarily unavailable' });
      }

      if (isJwtExpiredError(error)) {
        return err({ key: 'expired_token', message: 'Token has expired' });
      }

      logger.debug('JWT validation failed', { error: error instanceof Error ? error.message : String(error) });

      return err({ key: 'invalid_token', message: 'Invalid or malformed JWT' });
    }
  }

  /**
   * Validate a JWT from an Authorization header value.
   */
  async function validateAuthorizationHeader(
    authorizationHeader: string | undefined,
  ): Promise<ValidateResult<TToken>> {
    const token = extractBearerToken(authorizationHeader);
    if (!token) {
      return err({ key: 'missing_token', message: 'Missing or malformed Authorization header' });
    }
    return validateToken(token);
  }

  return {
    validateToken,
    validateAuthorizationHeader,
    extractBearerToken,
  };
}
