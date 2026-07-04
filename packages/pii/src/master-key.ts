import crypto from 'node:crypto';
import { type Result, type OctError, ok, err } from '@octabits-io/foundation/result';
import { encryptSymmetric, decryptSymmetric } from './encryption.ts';

export interface MasterKeyError extends OctError {
  key: 'master_key_error';
  message: string;
}

/**
 * Provider for master key operations (encrypting/decrypting data keys).
 *
 * The master key is used to encrypt data keys at rest.
 * This abstraction allows swapping implementations (env var, KMS, Vault, HSM).
 */
export interface MasterKeyProvider {
  /** Encrypt data with master key (for storing data keys) */
  encrypt(plaintext: Buffer): Promise<Result<Buffer, MasterKeyError>>;
  /** Decrypt data with master key (for retrieving data keys) */
  decrypt(ciphertext: Buffer): Promise<Result<Buffer, MasterKeyError>>;
}

const DEFAULT_MASTER_KEY_INFO = 'oct-master-key-v1';

/**
 * Minimum length for the master key source. 32 characters of a base64- or
 * hex-encoded random value; HKDF only reshapes key material, it does not add
 * entropy or stretch weak inputs.
 */
export const MIN_MASTER_KEY_SOURCE_LENGTH = 32;

/**
 * Create a MasterKeyProvider using an environment variable as the master key source.
 *
 * The master key is derived using HKDF-SHA256 to ensure it's exactly 32 bytes
 * regardless of the input key length.
 *
 * @param masterKeySource - The source key material (e.g., from environment variable).
 *   Must be cryptographically random, not a human-chosen passphrase — HKDF does no
 *   password stretching, so a guessable source is brute-forceable regardless of the
 *   derived key size. Generate with `openssl rand -base64 32`. Minimum 32 characters.
 * @param info - Optional HKDF info parameter (default: 'oct-master-key-v1')
 * @throws {Error} if `masterKeySource` is shorter than 32 characters (misconfiguration —
 *   fail fast at startup rather than encrypt under a weak key)
 */
export function createEnvVarMasterKeyProvider(masterKeySource: string, info = DEFAULT_MASTER_KEY_INFO): MasterKeyProvider {
  if (masterKeySource.length < MIN_MASTER_KEY_SOURCE_LENGTH) {
    throw new Error(
      `Master key source must be at least ${MIN_MASTER_KEY_SOURCE_LENGTH} characters of cryptographically random material (got ${masterKeySource.length}). Generate one with: openssl rand -base64 32`,
    );
  }

  // Derive a 32-byte key from the source using HKDF
  const derivedKey = crypto.hkdfSync('sha256', masterKeySource, '', info, 32);
  const key = Buffer.from(derivedKey);

  return {
    async encrypt(plaintext: Buffer): Promise<Result<Buffer, MasterKeyError>> {
      const result = encryptSymmetric(plaintext.toString('utf8'), key);
      if (!result.ok) {
        return err({ key: 'master_key_error' as const, message: `Failed to encrypt with master key: ${result.error.message}` });
      }
      return ok(result.value);
    },

    async decrypt(ciphertext: Buffer): Promise<Result<Buffer, MasterKeyError>> {
      const result = decryptSymmetric(ciphertext, key);
      if (!result.ok) {
        return err({ key: 'master_key_error' as const, message: `Failed to decrypt with master key: ${result.error.message}` });
      }
      return ok(Buffer.from(result.value, 'utf8'));
    },
  };
}
