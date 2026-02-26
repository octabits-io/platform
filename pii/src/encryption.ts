import { type OctError, type Result } from '@octabits-io/foundation/result';
import crypto from 'node:crypto';
import { Encrypter, Decrypter } from './typage/index.js';

const ALGORITHM = 'aes-256-gcm'; // Use GCM for authenticated encryption
const KEY_SIZE = 32; // 256 bits
const IV_SIZE = 12; // Recommended size for GCM
const AUTH_TAG_SIZE = 16; // Size of the authentication tag

export interface SymmetricEncryptionError extends OctError {
  key: 'symmetric_encryption_error';
}

export interface HybridEncryptionError extends OctError {
  key: 'hybrid_encryption_error';
}

export interface HybridDecryptionError extends OctError {
  key: 'hybrid_decryption_error';
}

export interface InvalidFormatError extends OctError {
  key: 'invalid_format_error';
}

/**
 * Detect if encrypted data is in age format.
 * Age files start with "age" header (0x61, 0x67, 0x65).
 */
export function isAgeFormat(data: Buffer): boolean {
  return data.length >= 3 && data.subarray(0, 3).toString() === 'age';
}


export function encryptSymmetric(value: string, symmetricKey: Buffer): Result<Buffer, SymmetricEncryptionError> {
  const iv = crypto.randomBytes(IV_SIZE);
  const cipher = crypto.createCipheriv(ALGORITHM, symmetricKey, iv, {
    authTagLength: AUTH_TAG_SIZE,
  });
  let encData = cipher.update(value, 'utf8');
  encData = Buffer.concat([encData, cipher.final()]);
  const authTag = cipher.getAuthTag();
  const buffer = Buffer.concat([iv, authTag, encData]);
  return {
    ok: true,
    value: buffer
  }
}

export function decryptSymmetric(encrypted: Buffer, symmetricKey: Buffer): Result<string, SymmetricEncryptionError> {
  try {

    const iv = encrypted.subarray(0, IV_SIZE);
    const tag = encrypted.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
    const encData = encrypted.subarray(IV_SIZE + AUTH_TAG_SIZE);
    const decipher = crypto.createDecipheriv(ALGORITHM, symmetricKey, iv);
    decipher.setAuthTag(tag);
    let decryptedData = decipher.update(encData);
    decryptedData = Buffer.concat([decryptedData, decipher.final()]);
    return {
      ok: true,
      value: decryptedData.toString('utf8'),
    };
  } catch(e) {
    return {
      ok: false,
      error: { key: 'symmetric_encryption_error', message: e instanceof Error ? e.message : String(e) },
    }

  }
}

export function generateSymmetricKey() {
  return crypto.randomBytes(KEY_SIZE);
}

/**
 * Encrypt a value using age encryption (X25519 + ChaCha20-Poly1305).
 *
 * @param value - The plaintext string to encrypt
 * @param recipient - Age recipient (age1...) for encryption
 */
export async function encryptHybrid(value: string, recipient: string): Promise<Result<Buffer, HybridEncryptionError>> {
  try {
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    const ciphertext = await encrypter.encrypt(value);
    return {
      ok: true,
      value: Buffer.from(ciphertext),
    };
  } catch (error) {
    return {
      ok: false,
      error: { key: 'hybrid_encryption_error', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Decrypt a value using age encryption.
 *
 * @param encrypted - The encrypted data (must be age format)
 * @param identity - Age identity (AGE-SECRET-KEY-1...) for decryption
 */
export async function decryptHybrid(
  encrypted: Buffer,
  identity: string
): Promise<Result<string, HybridDecryptionError | InvalidFormatError>> {
  try {
    // Verify this is age format
    if (!isAgeFormat(encrypted)) {
      return {
        ok: false,
        error: {
          key: 'invalid_format_error',
          message: 'Data is not in age encryption format. Legacy RSA data must be migrated first.',
        },
      };
    }

    // Age format: use age decryption
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const plaintext = await decrypter.decrypt(encrypted, 'text');
    return {
      ok: true,
      value: plaintext,
    };
  } catch (error) {
    return {
      ok: false,
      error: { key: 'hybrid_decryption_error', message: error instanceof Error ? error.message : String(error) },
    };
  }
}
