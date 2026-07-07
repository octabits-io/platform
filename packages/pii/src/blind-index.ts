import { createHmac } from 'node:crypto';

/**
 * Minimum length for the blind-index HMAC key. The key must be a secure,
 * randomly generated secret — a short key makes the index guessable offline.
 */
export const MIN_BLIND_INDEX_KEY_LENGTH = 16;

/**
 * Creates a blind index (keyed HMAC hash) for exact-match searching on encrypted data.
 * Uses HMAC-SHA256 to produce a deterministic hash that can be stored alongside
 * encrypted data for lookup without revealing the plaintext.
 *
 * The blind index allows searching for exact matches on encrypted fields
 * without exposing the encryption key or the plaintext values.
 *
 * Canonicalization: the value is Unicode-normalized (NFKC), lowercased, and
 * trimmed before hashing, so visually identical inputs (e.g. composed vs
 * decomposed accents) produce the same index.
 *
 * @param value - The plaintext value to hash
 * @param key - The HMAC key (should be a secure, randomly generated secret)
 * @returns A Buffer containing the HMAC-SHA256 hash
 */
export function createBlindIndex(value: string, key: string): Buffer {
  const normalizedValue = value.normalize('NFKC').toLowerCase().trim();
  const hmac = createHmac('sha256', key);
  hmac.update(normalizedValue);
  return hmac.digest();
}

/**
 * Creates a blind index service with the configured key.
 * This service is used to generate blind indexes for encrypted PII fields
 * that need to be searchable (e.g., email, phone).
 *
 * @throws {Error} if `blindIndexKey` is shorter than 16 characters
 *   (misconfiguration — fail fast at startup rather than index under a weak key)
 */
export function createBlindIndexService(blindIndexKey: string) {
  if (blindIndexKey.length < MIN_BLIND_INDEX_KEY_LENGTH) {
    throw new Error(
      `Blind index key must be at least ${MIN_BLIND_INDEX_KEY_LENGTH} characters of cryptographically random material (got ${blindIndexKey.length}).`,
    );
  }

  return {
    /**
     * Generate a blind index for a value.
     * Returns null if value is null, undefined, or empty.
     *
     * @param value - The plaintext value to index
     * @returns Buffer containing the HMAC hash, or null if value is empty
     */
    generateIndex(value: string | null | undefined): Buffer | null {
      if (!value || value.trim() === '') {
        return null;
      }
      return createBlindIndex(value, blindIndexKey);
    },
  };
}

export type BlindIndexService = ReturnType<typeof createBlindIndexService>;
