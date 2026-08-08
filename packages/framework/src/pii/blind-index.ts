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
 * ## What a blind index does and does not hide
 *
 * The index is deterministic — that is the point, and it is also the leak.
 * Anyone who can read the column learns **equality and frequency** without any
 * key: which rows share a value, and how often each value repeats. Encrypting
 * the field does not hide that; only the plaintext is hidden.
 *
 * And an index is only as unguessable as the value under it. The key stops
 * offline enumeration, but if the key ever leaks alongside the table, an
 * attacker recovers every low-entropy field by hashing candidates: email
 * addresses, phone numbers, postcodes, dates of birth, and anything drawn from
 * a small set (status, country, gender) fall immediately. High-entropy values
 * (account numbers, long random ids) do not.
 *
 * So: **index only the fields you must actually look up by**, prefer them to
 * be high-entropy, and never blind-index a low-cardinality attribute — the
 * frequency histogram alone can re-identify rows there. Keep the key in a
 * different trust domain from the database (here: encrypted at rest under the
 * master key, decrypted only in the app process).
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
