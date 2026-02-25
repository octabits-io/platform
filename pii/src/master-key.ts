import crypto from 'node:crypto';
import type { Result, OctError } from '@octabits-io/foundation/result';
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
 * Create a MasterKeyProvider using an environment variable as the master key source.
 *
 * The master key is derived using HKDF-SHA256 to ensure it's exactly 32 bytes
 * regardless of the input key length.
 *
 * @param masterKeySource - The source key material (e.g., from environment variable)
 * @param info - Optional HKDF info parameter (default: 'oct-master-key-v1')
 */
export function createEnvVarMasterKeyProvider(masterKeySource: string, info = DEFAULT_MASTER_KEY_INFO): MasterKeyProvider {
  // Derive a 32-byte key from the source using HKDF
  const derivedKey = crypto.hkdfSync('sha256', masterKeySource, '', info, 32);
  const key = Buffer.from(derivedKey);

  return {
    async encrypt(plaintext: Buffer): Promise<Result<Buffer, MasterKeyError>> {
      const result = encryptSymmetric(plaintext.toString('utf8'), key);
      if (!result.ok) {
        return {
          ok: false,
          error: {
            key: 'master_key_error',
            message: `Failed to encrypt with master key: ${result.error.message}`,
          },
        };
      }
      return { ok: true, value: result.value };
    },

    async decrypt(ciphertext: Buffer): Promise<Result<Buffer, MasterKeyError>> {
      const result = decryptSymmetric(ciphertext, key);
      if (!result.ok) {
        return {
          ok: false,
          error: {
            key: 'master_key_error',
            message: `Failed to decrypt with master key: ${result.error.message}`,
          },
        };
      }
      return { ok: true, value: Buffer.from(result.value, 'utf8') };
    },
  };
}
