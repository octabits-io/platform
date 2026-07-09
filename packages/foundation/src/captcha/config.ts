import { z } from 'zod';

/**
 * ALTCHA proof-of-work captcha config. Captcha is a product choice (ALTCHA),
 * not platform foundation, so this fragment travels with the captcha package
 * rather than `@octabits-io/foundation/config-schema`.
 *
 * Self-contained: already `.optional()` and carries the "hmacSecret required
 * when enabled" refinement, so consumers use it directly as
 * `captcha: CAPTCHA_CONFIG_SCHEMA`.
 */
export const CAPTCHA_CONFIG_SCHEMA = z.object({
  enabled: z.coerce.boolean().default(false),
  // Required when enabled. Min 32 chars. Used for both ALTCHA challenge signing
  // and the minted verified-token HMAC.
  hmacSecret: z.string().min(32).optional(),
  // PBKDF2 iteration count.
  cost: z.coerce.number().positive().optional(),
  // Challenge validity window in ms.
  expiresMs: z.coerce.number().positive().optional(),
  // Verified-token TTL after successful redeem.
  verifiedTokenTtlMs: z.coerce.number().positive().optional(),
}).optional().superRefine((data, ctx) => {
  if (data?.enabled && !data.hmacSecret) {
    ctx.addIssue({
      code: 'custom',
      message: 'captcha.hmacSecret is required when captcha.enabled',
      path: ['hmacSecret'],
    });
  }
});
