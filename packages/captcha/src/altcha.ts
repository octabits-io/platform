import { createChallenge as altchaCreateChallenge, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { Challenge, Payload } from 'altcha-lib/types';
import type { Result } from '@octabits-io/foundation/result';
import type { DateProvider, LruCacheService } from '@octabits-io/foundation/utils';
import type {
  CaptchaService,
  CaptchaChallenge,
  CaptchaRedeemSuccess,
  CaptchaChallengeCreationError,
  CaptchaRedeemError,
  CaptchaValidateError,
} from './base/contract';

const DEFAULT_COST = 50_000;
const DEFAULT_EXPIRES_MS = 600_000;
const DEFAULT_VERIFIED_TOKEN_TTL_MS = 1_200_000;
const DEFAULT_NONCE_CACHE_MAX = 10_000;

export interface AltchaCaptchaServiceConfig {
  dateProvider: DateProvider;
  lruCacheService: LruCacheService;
  /** Master HMAC secret. Min 32 chars. The derived-key signing secret is derived from this. */
  hmacSecret: string;
  /** PBKDF2 iteration count (cost knob). Default 50_000. */
  cost?: number;
  /** Challenge validity window in ms. Default 10 min. */
  expiresMs?: number;
  /** Minted verified-token TTL in ms (returned by redeemChallenge). Default 20 min. */
  verifiedTokenTtlMs?: number;
  /** Max nonces to remember for replay protection. Default 10_000. */
  nonceCacheMaxSize?: number;
}

export interface AltchaCaptchaService extends CaptchaService {
  readonly type: 'altcha';
}

export const createAltchaCaptchaService = (
  config: AltchaCaptchaServiceConfig,
): AltchaCaptchaService => {
  const {
    dateProvider,
    lruCacheService,
    hmacSecret,
    cost = DEFAULT_COST,
    expiresMs = DEFAULT_EXPIRES_MS,
    verifiedTokenTtlMs = DEFAULT_VERIFIED_TOKEN_TTL_MS,
    nonceCacheMaxSize = DEFAULT_NONCE_CACHE_MAX,
  } = config;

  // Replay protection: a nonce can only be redeemed once within its expiry window.
  const seenNonces = lruCacheService.createCache<string, true>({
    maxSize: nonceCacheMaxSize,
    ttlMs: expiresMs,
  });

  // Domain-separated key for derived-key signatures, mirroring altcha-lib's
  // framework helpers (HMAC-SHA256 of the master secret, keyed with the literal
  // string 'derived-secret', hex-encoded).
  let hmacKeySignatureSecretPromise: Promise<string> | null = null;
  function getHmacKeySignatureSecret(): Promise<string> {
    if (!hmacKeySignatureSecretPromise) {
      hmacKeySignatureSecretPromise = hmacHex('derived-secret', hmacSecret);
    }
    return hmacKeySignatureSecretPromise;
  }

  return {
    type: 'altcha',

    async createChallenge(): Promise<Result<CaptchaChallenge, CaptchaChallengeCreationError>> {
      try {
        const expiresAt = new Date(dateProvider.now().getTime() + expiresMs);
        const challenge = await altchaCreateChallenge({
          algorithm: 'PBKDF2/SHA-256',
          cost,
          deriveKey,
          hmacSignatureSecret: hmacSecret,
          hmacKeySignatureSecret: await getHmacKeySignatureSecret(),
          expiresAt,
        });
        return {
          ok: true,
          value: {
            challenge,
            expires: expiresAt.getTime(),
          },
        };
      } catch {
        return {
          ok: false,
          error: {
            key: 'challenge_creation_failed',
            message: 'Failed to create captcha challenge',
          },
        };
      }
    },

    async redeemChallenge(
      rawPayload: string,
    ): Promise<Result<CaptchaRedeemSuccess, CaptchaRedeemError>> {
      const payload = decodePayload(rawPayload);
      if (!payload) {
        return invalidSolution();
      }

      let result;
      try {
        result = await verifySolution({
          challenge: payload.challenge,
          solution: payload.solution,
          hmacSignatureSecret: hmacSecret,
          hmacKeySignatureSecret: await getHmacKeySignatureSecret(),
          deriveKey,
        });
      } catch {
        return invalidSolution();
      }

      if (!result.verified) {
        return invalidSolution();
      }

      const nonce = payload.challenge.parameters.nonce;
      if (seenNonces.has(nonce)) {
        return invalidSolution();
      }
      seenNonces.set(nonce, true);

      const expires = dateProvider.now().getTime() + verifiedTokenTtlMs;
      const verifiedToken = await mintVerifiedToken(expires, hmacSecret);
      return {
        ok: true,
        value: { token: verifiedToken, expires },
      };
    },

    async validateToken(token: string): Promise<Result<void, CaptchaValidateError>> {
      const parsed = parseVerifiedToken(token);
      if (!parsed) {
        return tokenInvalid();
      }
      const expectedSig = await hmacHex(String(parsed.expires), hmacSecret);
      if (!constantTimeEquals(expectedSig, parsed.signature)) {
        return tokenInvalid();
      }
      if (parsed.expires < dateProvider.now().getTime()) {
        return {
          ok: false,
          error: { key: 'token_expired', message: 'Captcha token has expired' },
        };
      }
      return { ok: true, value: undefined };
    },
  };
};

function invalidSolution(): { ok: false; error: CaptchaRedeemError } {
  return {
    ok: false,
    error: {
      key: 'solution_invalid',
      message: 'Captcha solution is invalid or challenge has expired',
    },
  };
}

function tokenInvalid(): { ok: false; error: CaptchaValidateError } {
  return {
    ok: false,
    error: { key: 'token_invalid', message: 'Captcha token is invalid' },
  };
}

function decodePayload(raw: string): Payload | null {
  if (!raw) return null;
  try {
    const json = atob(raw);
    const parsed = JSON.parse(json) as Payload;
    if (
      !parsed
      || typeof parsed !== 'object'
      || !parsed.challenge
      || !parsed.solution
      || !parsed.challenge.parameters?.nonce
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

interface ParsedVerifiedToken {
  expires: number;
  signature: string;
}

function parseVerifiedToken(token: string): ParsedVerifiedToken | null {
  if (!token) return null;
  try {
    const decoded = base64UrlDecode(token);
    const dot = decoded.indexOf('.');
    if (dot <= 0) return null;
    const expires = Number(decoded.slice(0, dot));
    const signature = decoded.slice(dot + 1);
    if (!Number.isFinite(expires) || !signature) return null;
    return { expires, signature };
  } catch {
    return null;
  }
}

async function mintVerifiedToken(expires: number, secret: string): Promise<string> {
  const sig = await hmacHex(String(expires), secret);
  return base64UrlEncode(`${expires}.${sig}`);
}

async function hmacHex(data: string, key: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const cryptoKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return atob(input.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

// Re-exported for tests / external callers that want the raw challenge type.
export type { Challenge };
