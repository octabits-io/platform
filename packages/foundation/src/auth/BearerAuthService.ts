import type { OctError, Result } from '../result/index.ts';
import { err } from '../result/index.ts';

/** Dispatcher-level errors, distinct from any strategy's own error taxonomy. */
export type BearerAuthError =
  | { key: 'missing_token'; message: string }
  | { key: 'no_matching_strategy'; message: string };

/**
 * One way of validating a raw bearer token. Strategies are tried in order; the
 * first whose `matches` returns `true` owns the token and its `validate` result
 * is returned verbatim.
 */
export interface BearerStrategy<TValue, TError extends OctError = OctError> {
  /** Does this strategy claim the given raw token? First match wins. */
  matches(token: string): boolean;
  /** Validate a token this strategy claimed. */
  validate(token: string): Promise<Result<TValue, TError>> | Result<TValue, TError>;
}

/**
 * Extract the bearer token from an `Authorization: Bearer <token>` header value.
 * Returns `null` for a missing or malformed header.
 */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const parts = authorizationHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1] ?? null;
}

/**
 * Ordered bearer-strategy dispatcher — a single entrypoint for any incoming
 * `Authorization: Bearer ...` header.
 *
 * Each strategy declares which tokens it handles (`matches`) and how to validate
 * them (`validate`). The first strategy whose `matches` returns `true` handles
 * the token; strategies return the shared `Result<TValue, TError>` shape so
 * callers stay agnostic to which one ran. When no strategy matches, a
 * `no_matching_strategy` error is returned; a missing/malformed header yields
 * `missing_token`.
 */
export function createBearerAuthService<TValue, TError extends OctError = OctError>({
  strategies,
}: {
  strategies: BearerStrategy<TValue, TError>[];
}) {
  async function validateToken(
    token: string,
  ): Promise<Result<TValue, TError | BearerAuthError>> {
    const strategy = strategies.find((s) => s.matches(token));
    if (!strategy) {
      return err({
        key: 'no_matching_strategy',
        message: 'No bearer strategy matched the presented token',
      });
    }
    return strategy.validate(token);
  }

  async function validateAuthorizationHeader(
    authorizationHeader: string | undefined,
  ): Promise<Result<TValue, TError | BearerAuthError>> {
    const token = extractBearerToken(authorizationHeader);
    if (!token) {
      return err({
        key: 'missing_token',
        message: 'Missing or malformed Authorization header',
      });
    }
    return validateToken(token);
  }

  return {
    validateToken,
    validateAuthorizationHeader,
    extractBearerToken,
  };
}

export type BearerAuthService<TValue, TError extends OctError = OctError> = ReturnType<
  typeof createBearerAuthService<TValue, TError>
>;
