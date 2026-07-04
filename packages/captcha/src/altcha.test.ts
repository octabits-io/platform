import { describe, it, expect } from 'vitest';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { Challenge, Solution } from 'altcha-lib/types';
import { createLruCacheService } from '@octabits-io/foundation/utils';
import type { DateProvider } from '@octabits-io/foundation/utils';
import { createAltchaCaptchaService } from './altcha';

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

function makeService(opts?: { dateProvider?: ReturnType<typeof makeDateProvider>; expiresMs?: number; verifiedTokenTtlMs?: number }) {
  const dateProvider = opts?.dateProvider ?? makeDateProvider();
  const lruCacheService = createLruCacheService({ dateProvider });
  const service = createAltchaCaptchaService({
    dateProvider,
    lruCacheService,
    hmacSecret: HMAC_SECRET,
    cost: TEST_COST,
    expiresMs: opts?.expiresMs ?? 600_000,
    verifiedTokenTtlMs: opts?.verifiedTokenTtlMs ?? 1_200_000,
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
});
