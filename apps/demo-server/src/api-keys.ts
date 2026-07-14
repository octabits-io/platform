/**
 * API-key auth (`…/auth`) — the IdP-free half of the auth module.
 *
 * `createApiKeyFormat` owns the token mechanics (prefix + keyId + secret,
 * SHA-256 at rest, constant-time verify); `createBearerAuthService` dispatches
 * `Authorization: Bearer …` headers across strategies by prefix match. The
 * store here is a Map seeded with one bootstrap key that is printed to the log
 * exactly once — a real app persists `keyId → { secretHash, … }` rows and
 * re-resolves the caller's identity on every hit instead of trusting a stored
 * role.
 */
import { createApiKeyFormat, createBearerAuthService } from '@octabits-io/framework/auth';
import type { BearerStrategy } from '@octabits-io/framework/auth';
import { ok, err } from '@octabits-io/framework/result';
import type { Logger } from '@octabits-io/framework/logger';

export interface ApiKeyToken {
  keyId: string;
  label: string;
  role: 'admin' | 'viewer';
}

export function createDemoApiKeys(logger: Logger) {
  const format = createApiKeyFormat({ prefix: 'demo_' });
  const records = new Map<string, { secretHash: string; label: string; role: ApiKeyToken['role'] }>();

  function issue(label: string, role: ApiKeyToken['role']): string {
    const keyId = format.generateKeyId();
    const secret = format.generateSecret();
    records.set(keyId, { secretHash: format.hashSecret(secret), label, role });
    return format.formatToken(keyId, secret);
  }

  // Dev-only bootstrap credential. Printing a secret is acceptable exactly
  // once, at boot, in a demo — it exists so `curl -H "Authorization: Bearer …"`
  // works without any provisioning step.
  logger.info('Demo API key issued (printed once, dev use only)', {
    bearer: issue('bootstrap', 'admin'),
  });

  const apiKeyStrategy: BearerStrategy<ApiKeyToken> = {
    matches: format.isApiKeyToken,
    validate: (token) => {
      const parsed = format.parseToken(token);
      if (!parsed) return err({ key: 'invalid_token', message: 'Malformed API key' });
      const record = records.get(parsed.keyId);
      if (!record || !format.verifyHash(parsed.secret, record.secretHash)) {
        return err({ key: 'invalid_token', message: 'Unknown or revoked API key' });
      }
      return ok({ keyId: parsed.keyId, label: record.label, role: record.role });
    },
  };

  return {
    authService: createBearerAuthService<ApiKeyToken>({ strategies: [apiKeyStrategy] }),
    issue,
  };
}

export type DemoApiKeys = ReturnType<typeof createDemoApiKeys>;
