import type { Result } from '@octabits-io/foundation/result';
import type { DateProvider } from '@octabits-io/foundation/utils';
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

export const createNoopCaptchaService = (config?: { dateProvider?: DateProvider }): NoopCaptchaService => {
  const dateProvider = config?.dateProvider;
  const getNow = () => dateProvider ? dateProvider.now().getTime() : Date.now();

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
