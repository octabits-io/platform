import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Logger } from '../logger/types.ts';

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
 * Creates a JWT validation service that verifies OIDC-issued JWTs.
 *
 * Lazily fetches the JWKS URI from the issuer's OIDC discovery document on
 * first token validation, then uses jose's createRemoteJWKSet for signature
 * verification with automatic caching and key rotation. Verified payloads are
 * handed to the injected `claimMapper` to produce the domain token shape.
 */
export function createJwtValidationService<TToken>({
  issuerUrl,
  audience,
  logger,
  claimMapper,
  authBypassSecret,
  bypassToken,
}: JwtValidationServiceConfig<TToken>): JwtValidationService<TToken> {
  // Remove trailing slash from issuer URL
  const issuer = issuerUrl.replace(/\/$/, '');

  // JWKS initialized lazily on first token validation
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  let jwksInitPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;
  let lastDiscoveryFailureAt = 0;

  async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
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
          jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
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
   * Extract Bearer token from Authorization header.
   */
  function extractBearerToken(authorizationHeader: string | undefined): string | null {
    if (!authorizationHeader) return null;
    const parts = authorizationHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
    return parts[1]!;
  }

  /**
   * Validate a JWT and extract the validated token.
   */
  async function validateToken(token: string): Promise<ValidateResult<TToken>> {
    // E2E test bypass: if the token matches the bypass secret, return the synthetic
    // identity without contacting the OIDC provider. Dead code when the bypass secret
    // is unset, and hard-neutralized in production processes (see effectiveBypassSecret).
    if (effectiveBypassSecret && token === effectiveBypassSecret) {
      if (bypassToken === undefined) {
        logger.error('Auth bypass secret matched but no bypassToken was configured — rejecting.');
        return {
          ok: false,
          error: { key: 'invalid_token', message: 'Auth bypass not configured' },
        };
      }
      logger.warn('Auth bypass active — using synthetic token for E2E testing');
      return { ok: true, value: bypassToken };
    }

    try {
      const resolvedJwks = await getJwks();
      const { payload } = await jwtVerify(token, resolvedJwks, {
        issuer,
        audience,
      });

      const mapped = claimMapper(payload);
      if (!mapped.ok) {
        return {
          ok: false,
          error: { key: 'missing_claims', message: mapped.message },
        };
      }

      return { ok: true, value: mapped.value };
    } catch (error) {
      if (error instanceof OidcDiscoveryError) {
        logger.warn('OIDC discovery unavailable — cannot validate JWT', {
          issuer,
          error: error.cause instanceof Error ? error.cause.message : error.message,
        });
        return {
          ok: false,
          error: { key: 'jwks_unavailable', message: 'Auth provider temporarily unavailable' },
        };
      }

      if (error instanceof Error) {
        if (error.message.includes('exp') || error.message.includes('expired')) {
          return {
            ok: false,
            error: { key: 'expired_token', message: 'Token has expired' },
          };
        }
      }

      logger.debug('JWT validation failed', { error: error instanceof Error ? error.message : String(error) });

      return {
        ok: false,
        error: { key: 'invalid_token', message: 'Invalid or malformed JWT' },
      };
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
      return {
        ok: false,
        error: { key: 'missing_token', message: 'Missing or malformed Authorization header' },
      };
    }
    return validateToken(token);
  }

  return {
    validateToken,
    validateAuthorizationHeader,
    extractBearerToken,
  };
}
