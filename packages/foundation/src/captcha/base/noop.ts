import type { Result } from '../../result/index.ts';
import type { DateProvider } from '../../utils/index.ts';
import type { Logger } from '../../logger/index.ts';
import type {
  CaptchaService,
  CaptchaChallenge,
  CaptchaRedeemSuccess,
  CaptchaChallengeCreationError,
  CaptchaRedeemError,
  CaptchaValidateError,
} from './contract';

// ============================================================================
// Noop Captcha Service (used when captcha is disabled)
// ============================================================================

export interface NoopCaptchaService extends CaptchaService {
  readonly type: 'noop';
}

/**
 * No-op captcha for dev/test: every challenge auto-passes and every token
 * validates. It provides ZERO protection — never wire it up in production.
 * Construction logs a warning (via `config.logger` when provided, otherwise
 * `console.warn`) so an accidentally active no-op is visible in logs.
 */
export const createNoopCaptchaService = (config?: { dateProvider?: DateProvider; logger?: Logger }): NoopCaptchaService => {
  const dateProvider = config?.dateProvider;
  const getNow = () => dateProvider ? dateProvider.now().getTime() : Date.now();

  const warning = 'captcha no-op provider active — all challenges auto-pass';
  if (config?.logger) {
    config.logger.warn(warning);
  } else {
    console.warn(warning);
  }

  return {
    type: 'noop',

    async createChallenge(): Promise<Result<CaptchaChallenge, CaptchaChallengeCreationError>> {
      return {
        ok: true,
        value: {
          challenge: { parameters: {} },
          expires: getNow() + 3_600_000,
        },
      };
    },

    async redeemChallenge(_payload: string): Promise<Result<CaptchaRedeemSuccess, CaptchaRedeemError>> {
      return {
        ok: true,
        value: {
          token: 'noop-verified-token',
          expires: getNow() + 1_200_000,
        },
      };
    },

    async validateToken(_token: string): Promise<Result<void, CaptchaValidateError>> {
      return { ok: true, value: undefined };
    },
  };
};
