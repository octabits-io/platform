import { createChallenge as altchaCreateChallenge, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { Challenge, Payload } from 'altcha-lib/types';
import type { Result } from '../result/index.ts';
import type { DateProvider, LruCacheService } from '../utils/index.ts';
import type {
  CaptchaService,
  CaptchaChallenge,
  CaptchaRedeemSuccess,
  CaptchaChallengeCreationError,
  CaptchaRedeemError,
  CaptchaValidateError,
  CaptchaTokenOptions,
} from './base/contract';

const DEFAULT_COST = 50_000;
const DEFAULT_EXPIRES_MS = 600_000;
const DEFAULT_VERIFIED_TOKEN_TTL_MS = 1_200_000;
const DEFAULT_NONCE_CACHE_MAX = 10_000;

/**
 * Pluggable nonce store for challenge replay protection.
 *
 * Implementations MUST make `markRedeemed` an atomic check-and-set — a
 * separate has()-then-set() with an await in between reopens the
 * double-redemption race this seam exists to close. A Redis-backed store maps
 * naturally onto `SET <nonce> 1 NX PX <ttlMs>` (returns true on first set,
 * false on replay). The default store is a per-process synchronous LRU.
 */
export interface CaptchaNonceStore {
  /**
   * Atomically record `nonce` as redeemed for at least `ttlMs` milliseconds
   * (the challenge expiry window — after that, altcha's own expiry check
   * rejects the payload anyway). Returns `true` when the nonce was fresh
   * (this call redeemed it) and `false` when it was already redeemed.
   */
  markRedeemed(nonce: string, ttlMs: number): boolean | Promise<boolean>;
}

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
  /** Max nonces the DEFAULT in-process store remembers for replay protection. Default 10_000. Ignored when `nonceStore` is provided. */
  nonceCacheMaxSize?: number;
  /**
   * Replay-protection store. Defaults to a per-process LRU built from
   * `lruCacheService` — see the deployment caveats on
   * `createAltchaCaptchaService`. Provide a shared store (e.g. Redis-backed)
   * for multi-instance deployments.
   */
  nonceStore?: CaptchaNonceStore;
}

export interface AltchaCaptchaService extends CaptchaService {
  readonly type: 'altcha';
}

/**
 * ALTCHA proof-of-work captcha service.
 *
 * Replay protection — deployment caveats for the DEFAULT nonce store:
 * - It is **per-process**. In a multi-instance deployment each instance keeps
 *   its own nonce set, so a solved challenge can be redeemed once *per
 *   instance* (N instances → up to N redemptions). Provide a shared
 *   `nonceStore` (e.g. Redis `SET NX PX`) when that matters.
 * - It is an **LRU capped at `nonceCacheMaxSize`** (default 10_000). More
 *   redemptions than that within one `expiresMs` window can evict live nonces
 *   early, re-enabling replay of the evicted ones. Exposure is bounded by the
 *   challenge expiry (`expiresMs`): altcha's own expiry check rejects stale
 *   payloads regardless of the nonce store.
 */
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

  // Replay protection: a nonce can only be redeemed once within its expiry
  // window. Default store: per-process synchronous LRU (caveats on the
  // factory jsdoc above).
  const nonceStore: CaptchaNonceStore = config.nonceStore ?? (() => {
    const seenNonces = lruCacheService.createCache<string, true>({
      maxSize: nonceCacheMaxSize,
      ttlMs: expiresMs,
    });
    return {
      markRedeemed(nonce: string): boolean {
        // Synchronous check-and-set — no await may ever sit between the
        // has() and the set(), or two concurrent redemptions of the same
        // nonce could both pass.
        if (seenNonces.has(nonce)) return false;
        seenNonces.set(nonce, true);
        return true;
      },
    };
  })();

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
      } catch (error) {
        // Surface the underlying failure reason (never the secret — error
        // messages from altcha-lib / WebCrypto do not contain key material).
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            key: 'challenge_creation_failed',
            message: `Failed to create captcha challenge: ${detail}`,
          },
        };
      }
    },

    async redeemChallenge(
      rawPayload: string,
      options?: CaptchaTokenOptions,
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

      // Redemption-order invariant: verify the solution FIRST (the slow,
      // awaited part), THEN atomically check-and-set the nonce. Doing the
      // nonce check before/around the awaited verification would open a
      // TOCTOU window in which two concurrent redemptions both pass.
      const nonce = payload.challenge.parameters.nonce;
      const fresh = await nonceStore.markRedeemed(nonce, expiresMs);
      if (!fresh) {
        return invalidSolution();
      }

      const expires = dateProvider.now().getTime() + verifiedTokenTtlMs;
      const verifiedToken = await mintVerifiedToken(expires, hmacSecret, options?.bind);
      return {
        ok: true,
        value: { token: verifiedToken, expires },
      };
    },

    async validateToken(token: string, options?: CaptchaTokenOptions): Promise<Result<void, CaptchaValidateError>> {
      const parsed = parseVerifiedToken(token);
      if (!parsed) {
        return tokenInvalid();
      }
      const expectedSig = await hmacHex(tokenSigningInput(parsed.expires, options?.bind), hmacSecret);
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

/**
 * HMAC input for verified tokens. Without a bind this is exactly the legacy
 * input (`String(expires)`), so unbound tokens stay wire-compatible. With a
 * bind, the bind string is mixed in behind a NUL separator (which cannot
 * appear in the decimal `expires`), domain-separating bound from unbound
 * tokens. An empty-string bind is treated as "no bind".
 */
function tokenSigningInput(expires: number, bind?: string): string {
  return bind ? `${expires}\u0000bind\u0000${bind}` : String(expires);
}

async function mintVerifiedToken(expires: number, secret: string, bind?: string): Promise<string> {
  const sig = await hmacHex(tokenSigningInput(expires, bind), secret);
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
