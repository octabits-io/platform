// ============================================================================
// @octabits-io/foundation/captcha — provider-agnostic captcha contract
// ============================================================================
//
// The root entry is vendor-free: the service contract, the error taxonomy, the
// no-op transport (for dev/test), and the ALTCHA config schema fragment. The
// concrete ALTCHA implementation lives behind a subpath export so consumers
// only load `altcha-lib` when they actually use it:
//
//   @octabits-io/foundation/captcha/altcha  — altcha-lib (optional peer)

// --- Service contract ------------------------------------------------------
export type {
  CaptchaService,
  CaptchaTokenOptions,
  CaptchaChallenge,
  CaptchaRedeemSuccess,
  CaptchaChallengeCreationError,
  CaptchaSolutionInvalidError,
  CaptchaTokenInvalidError,
  CaptchaTokenExpiredError,
  CaptchaRedeemError,
  CaptchaValidateError,
} from './base/contract';

// --- No-op transport (captcha disabled) ------------------------------------
export { createNoopCaptchaService } from './base/noop';
export type { NoopCaptchaService } from './base/noop';

// --- Config schema ---------------------------------------------------------
export { CAPTCHA_CONFIG_SCHEMA } from './config';

// ============================================================================
// Discriminated Union Type
// ============================================================================

import type { CaptchaService } from './base/contract';
import type { NoopCaptchaService } from './base/noop';

/**
 * Discriminated union of all CaptchaService implementations. The concrete
 * altcha branch lives behind the `./altcha` subpath; we declare it structurally
 * here so the root entry stays vendor-free (no `altcha-lib` import).
 */
export type TypedCaptchaService =
  | NoopCaptchaService
  | (CaptchaService & { readonly type: 'altcha' });
