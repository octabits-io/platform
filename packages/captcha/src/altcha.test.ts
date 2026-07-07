import { describe, it, expect, vi } from 'vitest';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { Challenge, Solution } from 'altcha-lib/types';
import { createLruCacheService } from '@octabits-io/foundation/utils';
import type { DateProvider } from '@octabits-io/foundation/utils';
import { createAltchaCaptchaService, type CaptchaNonceStore } from './altcha';

const HMAC_SECRET = '0123456789abcdef0123456789abcdef'; // 32 chars
// Low cost so tests stay fast — a real prod cost would be much higher.
const TEST_COST = 100;

// Anchored on real wall-clock time so that challenges created with `expiresAt`
// in the near future still pass altcha-lib's `verifySolution` expiry check
// (which calls real `Date.now()` and is not injectable). Tests that need to
// trigger expiry use a controlled negative `expiresMs` instead.
function makeDateProvider(initialMs = Date.now()): DateProvider & {
  advance(ms: number): void;
} {
  let now = initialMs;
  return {
    now: () => new Date(now),
    advance(ms: number) { now += ms; },
  };
}

function makeService(opts?: { dateProvider?: ReturnType<typeof makeDateProvider>; expiresMs?: number; verifiedTokenTtlMs?: number; nonceStore?: CaptchaNonceStore }) {
  const dateProvider = opts?.dateProvider ?? makeDateProvider();
  const lruCacheService = createLruCacheService({ dateProvider });
  const service = createAltchaCaptchaService({
    dateProvider,
    lruCacheService,
    hmacSecret: HMAC_SECRET,
    cost: TEST_COST,
    expiresMs: opts?.expiresMs ?? 600_000,
    verifiedTokenTtlMs: opts?.verifiedTokenTtlMs ?? 1_200_000,
    nonceStore: opts?.nonceStore,
  });
  return { service, dateProvider };
}

async function solveAndEncode(challenge: Challenge): Promise<string> {
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error('Failed to solve challenge');
  return encodePayload(challenge, solution);
}

function encodePayload(challenge: Challenge, solution: Solution): string {
  return btoa(JSON.stringify({ challenge, solution }));
}

describe('AltchaCaptchaService', () => {
  describe('createChallenge', () => {
    it('returns a signed PBKDF2/SHA-256 challenge', async () => {
      const { service } = makeService();
      const result = await service.createChallenge();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const challenge = result.value.challenge as Challenge;
      expect(challenge.parameters.algorithm).toBe('PBKDF2/SHA-256');
      expect(challenge.parameters.cost).toBe(TEST_COST);
      expect(challenge.signature).toBeTruthy();
      expect(typeof challenge.parameters.nonce).toBe('string');
      expect(result.value.expires).toBeGreaterThan(0);
    });
  });

  describe('end-to-end happy path', () => {
    it('create → solve → redeem → validate', async () => {
      const { service } = makeService();
      const created = await service.createChallenge();
      if (!created.ok) throw new Error('createChallenge failed');

      const payload = await solveAndEncode(created.value.challenge as Challenge);
      const redeemed = await service.redeemChallenge(payload);
      expect(redeemed.ok).toBe(true);
      if (!redeemed.ok) return;
      expect(redeemed.value.token).toBeTruthy();
      expect(redeemed.value.expires).toBeGreaterThan(Date.now() - 60_000);

      const validated = await service.validateToken(redeemed.value.token);
      expect(validated.ok).toBe(true);
    });
  });

  describe('redeemChallenge — failure modes', () => {
    it('rejects an empty token', async () => {
      const { service } = makeService();
      const result = await service.redeemChallenge('');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.key).toBe('solution_invalid');
    });

    it('rejects a malformed base64 payload', async () => {
      const { service } = makeService();
      const result = await service.redeemChallenge('not-base64!!');
      expect(result.ok).toBe(false);
    });

    it('rejects payloads without challenge/solution shape', async () => {
      const { service } = makeService();
      const bogus = btoa(JSON.stringify({ hello: 'world' }));
      const result = await service.redeemChallenge(bogus);
      expect(result.ok).toBe(false);
    });

    it('rejects a tampered challenge signature', async () => {
      const { service } = makeService();
      const created = await service.createChallenge();
      if (!created.ok) throw new Error('createChallenge failed');
      const challenge = created.value.challenge as Challenge;

      const solution = await solveChallenge({ challenge, deriveKey });
      if (!solution) throw new Error('solve failed');
      const tampered: Challenge = { ...challenge, signature: 'a'.repeat((challenge.signature ?? '').length || 64) };
      const payload = encodePayload(tampered, solution);
      const result = await service.redeemChallenge(payload);
      expect(result.ok).toBe(false);
    });

    it('rejects a replay of a valid solution', async () => {
      const { service } = makeService();
      const created = await service.createChallenge();
      if (!created.ok) throw new Error('createChallenge failed');
      const payload = await solveAndEncode(created.value.challenge as Challenge);

      const first = await service.redeemChallenge(payload);
      expect(first.ok).toBe(true);
      const second = await service.redeemChallenge(payload);
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.key).toBe('solution_invalid');
    });

    it('rejects a concurrent double-redeem of the same payload (exactly one succeeds)', async () => {
      const { service } = makeService();
      const created = await service.createChallenge();
      if (!created.ok) throw new Error('createChallenge failed');
      const payload = await solveAndEncode(created.value.challenge as Challenge);

      const [first, second] = await Promise.all([
        service.redeemChallenge(payload),
        service.redeemChallenge(payload),
      ]);

      const okCount = [first, second].filter((r) => r.ok).length;
      expect(okCount).toBe(1);
      const failed = [first, second].find((r) => !r.ok);
      if (failed && !failed.ok) {
        expect(failed.error.key).toBe('solution_invalid');
      }
    });

    it('uses an injected nonce store for replay protection', async () => {
      const seen = new Set<string>();
      const markRedeemed = vi.fn(async (nonce: string, _ttlMs: number) => {
        if (seen.has(nonce)) return false;
        seen.add(nonce);
        return true;
      });
      const { service } = makeService({ nonceStore: { markRedeemed } });

      const created = await service.createChallenge();
      if (!created.ok) throw new Error('createChallenge failed');
      const payload = await solveAndEncode(created.value.challenge as Challenge);

      const first = await service.redeemChallenge(payload);
      const second = await service.redeemChallenge(payload);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      expect(markRedeemed).toHaveBeenCalledTimes(2);
      // ttlMs (the challenge expiry window) is forwarded to the store
      expect(markRedeemed.mock.calls[0]![1]).toBe(600_000);
    });

    it('rejects a solution after the challenge expiry window', async () => {
      // Negative expiresMs makes the challenge expired-on-arrival relative to
      // real wall-clock time, which is what altcha-lib's `verifySolution`
      // checks against. Avoids needing to monkey-patch `Date.now`.
      const { service } = makeService({ expiresMs: -60_000 });
      const created = await service.createChallenge();
      if (!created.ok) throw new Error('createChallenge failed');
      const payload = await solveAndEncode(created.value.challenge as Challenge);

      const result = await service.redeemChallenge(payload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.key).toBe('solution_invalid');
    });
  });

  describe('validateToken — failure modes', () => {
    it('rejects a corrupted token', async () => {
      const { service } = makeService();
      const result = await service.validateToken('not-a-valid-token');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.key).toBe('token_invalid');
    });

    it('rejects an empty token', async () => {
      const { service } = makeService();
      const result = await service.validateToken('');
      expect(result.ok).toBe(false);
    });

    it('rejects a near-miss forgery: valid structure and expiry but wrong signature', async () => {
      const dateProvider = makeDateProvider();
      const { service } = makeService({ dateProvider });

      // Structurally valid token: plausible future expiry, hex signature of
      // the right length — but not produced with the HMAC secret. Exercises
      // the constant-time compare path.
      const expires = dateProvider.now().getTime() + 600_000;
      const forgedSig = 'ab'.repeat(32); // 64 hex chars, like a real HMAC-SHA256
      const forged = btoa(`${expires}.${forgedSig}`)
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const result = await service.validateToken(forged);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.key).toBe('token_invalid');
    });

    it('returns token_expired after the verified-token TTL elapses', async () => {
      const dateProvider = makeDateProvider();
      const { service } = makeService({ dateProvider, verifiedTokenTtlMs: 60_000 });
      const created = await service.createChallenge();
      if (!created.ok) throw new Error('createChallenge failed');
      const payload = await solveAndEncode(created.value.challenge as Challenge);
      const redeemed = await service.redeemChallenge(payload);
      if (!redeemed.ok) throw new Error('redeem failed');

      dateProvider.advance(120_000);
      const validated = await service.validateToken(redeemed.value.token);
      expect(validated.ok).toBe(false);
      if (validated.ok) return;
      expect(validated.error.key).toBe('token_expired');
    });
  });

  describe('token binding', () => {
    async function redeemWithBind(bind?: string) {
      const { service } = makeService();
      const created = await service.createChallenge();
      if (!created.ok) throw new Error('createChallenge failed');
      const payload = await solveAndEncode(created.value.challenge as Challenge);
      const redeemed = await service.redeemChallenge(payload, bind === undefined ? undefined : { bind });
      if (!redeemed.ok) throw new Error('redeem failed');
      return { service, token: redeemed.value.token };
    }

    it('a bound token validates with the matching bind', async () => {
      const { service, token } = await redeemWithBind('session-abc');
      const result = await service.validateToken(token, { bind: 'session-abc' });
      expect(result.ok).toBe(true);
    });

    it('a bound token fails with a different bind', async () => {
      const { service, token } = await redeemWithBind('session-abc');
      const result = await service.validateToken(token, { bind: 'session-xyz' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.key).toBe('token_invalid');
    });

    it('a bound token fails when validated without a bind', async () => {
      const { service, token } = await redeemWithBind('session-abc');
      const result = await service.validateToken(token);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.key).toBe('token_invalid');
    });

    it('an unbound token fails when a bind is required at validation', async () => {
      const { service, token } = await redeemWithBind(undefined);
      const result = await service.validateToken(token, { bind: 'session-abc' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.key).toBe('token_invalid');
    });

    it('an unbound token keeps validating without a bind (legacy behavior)', async () => {
      const { service, token } = await redeemWithBind(undefined);
      const result = await service.validateToken(token);
      expect(result.ok).toBe(true);
    });
  });
});
