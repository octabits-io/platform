import { createHmac } from 'crypto';

/**
 * Creates a blind index (keyed HMAC hash) for exact-match searching on encrypted data.
 * Uses HMAC-SHA256 to produce a deterministic hash that can be stored alongside
 * encrypted data for lookup without revealing the plaintext.
 *
 * The blind index allows searching for exact matches on encrypted fields
 * without exposing the encryption key or the plaintext values.
 *
 * @param value - The plaintext value to hash
 * @param key - The HMAC key (should be a secure, randomly generated secret)
 * @returns A Buffer containing the HMAC-SHA256 hash
 */
export function createBlindIndex(value: string, key: string): Buffer {
  const normalizedValue = value.toLowerCase().trim();
  const hmac = createHmac('sha256', key);
  hmac.update(normalizedValue);
  return hmac.digest();
}

/**
 * Creates a blind index service with the configured key.
 * This service is used to generate blind indexes for encrypted PII fields
 * that need to be searchable (e.g., email, phone).
 */
export function createBlindIndexService(blindIndexKey: string) {
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
