import type { Result, OctErrorWithKey } from '../../result/index.ts';

// ============================================================================
// Error Types
// ============================================================================

export type CaptchaChallengeCreationError = OctErrorWithKey<'challenge_creation_failed'>;
export type CaptchaSolutionInvalidError = OctErrorWithKey<'solution_invalid'>;
export type CaptchaTokenInvalidError = OctErrorWithKey<'token_invalid'>;
export type CaptchaTokenExpiredError = OctErrorWithKey<'token_expired'>;

export type CaptchaRedeemError = CaptchaSolutionInvalidError;

export type CaptchaValidateError =
  | CaptchaTokenInvalidError
  | CaptchaTokenExpiredError;

// ============================================================================
// Result Types
// ============================================================================

export interface CaptchaChallenge {
  /** Provider-specific challenge object the client must solve. */
  challenge: unknown;
  /** Challenge expiry in unix-epoch milliseconds. */
  expires: number;
}

export interface CaptchaRedeemSuccess {
  /** Opaque verified token to attach to subsequent form submissions. */
  token: string;
  /** Verified-token expiry in unix-epoch milliseconds. */
  expires: number;
}

// ============================================================================
// Service Interface
// ============================================================================

export interface CaptchaTokenOptions {
  /**
   * Optional binding context (e.g. a session id, user id, or client-IP hash)
   * mixed into the verified token's signature at mint time. A token minted
   * with a `bind` only validates when the identical `bind` is passed to
   * `validateToken`; a token minted without one validates without it
   * (unchanged legacy behavior). Binding prevents a verified token issued to
   * one client from being replayed by another within its TTL.
   */
  bind?: string;
}

export interface CaptchaService {
  readonly type: string;
  createChallenge(): Promise<Result<CaptchaChallenge, CaptchaChallengeCreationError>>;
  /**
   * Verify a solved client payload (provider-specific opaque string) and
   * return a short-lived verified token that the form-submit endpoint
   * accepts via `validateToken`. The verified token is intentionally
   * multi-use within its TTL (reusable across legitimate retries); pass
   * `options.bind` to at least pin it to one session/user/IP.
   */
  redeemChallenge(payload: string, options?: CaptchaTokenOptions): Promise<Result<CaptchaRedeemSuccess, CaptchaRedeemError>>;
  validateToken(token: string, options?: CaptchaTokenOptions): Promise<Result<void, CaptchaValidateError>>;
}
