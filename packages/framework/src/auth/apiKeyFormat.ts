import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Format of an issued API key:
 *
 *   <prefix><keyId>.<secret>
 *
 * - `<prefix>` (caller-chosen, e.g. `acme_`) lets a bearer dispatcher route to
 *   the API-key validator without ambiguity vs JWT bearer tokens.
 * - `keyId` is a high-entropy lookup id (stored as the row's primary key) so
 *   validation can fetch the row in O(1) before any cryptographic compare.
 * - `secret` is the unguessable half. Only its SHA-256 hash is persisted.
 *
 * Both halves use the base64url alphabet (URL-safe, no padding). The `.`
 * separator is not in base64url, so the split between keyId and secret is
 * unambiguous even when either half contains `_`.
 */
const KEY_ID_SECRET_SEPARATOR = '.';

const KEY_ID_BYTES = 9; // 12 base64url chars
const SECRET_BYTES = 32; // 43 base64url chars (~256 bits of entropy)

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

function base64url(bytes: Buffer): string {
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function isBase64Url(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * Build an API-key format helper for a given token `prefix`. Returns pure
 * `node:crypto` generate/parse/verify functions — no I/O, no domain coupling.
 * The consumer owns key storage; this only shapes and checks tokens.
 */
export function createApiKeyFormat({ prefix }: { prefix: string }) {
  function generateKeyId(): string {
    return base64url(randomBytes(KEY_ID_BYTES));
  }

  function generateSecret(): string {
    return base64url(randomBytes(SECRET_BYTES));
  }

  function formatToken(keyId: string, secret: string): string {
    return `${prefix}${keyId}${KEY_ID_SECRET_SEPARATOR}${secret}`;
  }

  /** Public visible portion of a key — shown in lists for identification. */
  function deriveKeyPrefix(keyId: string): string {
    return `${prefix}${keyId}`;
  }

  function isApiKeyToken(rawBearer: string): boolean {
    return rawBearer.startsWith(prefix);
  }

  function parseToken(rawBearer: string): ParsedApiKey | null {
    if (!isApiKeyToken(rawBearer)) return null;
    const remainder = rawBearer.slice(prefix.length);
    const sep = remainder.indexOf(KEY_ID_SECRET_SEPARATOR);
    if (sep <= 0 || sep === remainder.length - 1) return null;
    const keyId = remainder.slice(0, sep);
    const secret = remainder.slice(sep + 1);
    if (!isBase64Url(keyId) || !isBase64Url(secret)) return null;
    return { keyId, secret };
  }

  function hashSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  /**
   * Constant-time comparison of two hex digests. Hex strings of equal length
   * (always the case for SHA-256 outputs) so the length-mismatch fast path is
   * never taken; included only as a safety guard against malformed stored hashes.
   */
  function verifyHash(secret: string, expectedHashHex: string): boolean {
    const computed = Buffer.from(hashSecret(secret), 'hex');
    let expected: Buffer;
    try {
      expected = Buffer.from(expectedHashHex, 'hex');
    } catch {
      return false;
    }
    if (computed.length !== expected.length) return false;
    return timingSafeEqual(computed, expected);
  }

  return {
    prefix,
    generateKeyId,
    generateSecret,
    formatToken,
    deriveKeyPrefix,
    isApiKeyToken,
    parseToken,
    hashSecret,
    verifyHash,
  };
}

export type ApiKeyFormat = ReturnType<typeof createApiKeyFormat>;
