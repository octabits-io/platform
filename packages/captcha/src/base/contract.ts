import type { Result, OctErrorWithKey } from '@octabits-io/foundation/result';

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

export interface CaptchaService {
  readonly type: string;
  createChallenge(): Promise<Result<CaptchaChallenge, CaptchaChallengeCreationError>>;
  /**
   * Verify a solved client payload (provider-specific opaque string) and
   * return a short-lived verified token that the form-submit endpoint
   * accepts via `validateToken`. The verified token is reusable across
   * legitimate retries within its TTL.
   */
  redeemChallenge(payload: string): Promise<Result<CaptchaRedeemSuccess, CaptchaRedeemError>>;
  validateToken(token: string): Promise<Result<void, CaptchaValidateError>>;
}
