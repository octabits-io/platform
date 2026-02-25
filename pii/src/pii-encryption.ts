/**
 * PII Encryption Helpers
 *
 * High-level wrappers around hybrid encryption for encrypting/decrypting
 * Personally Identifiable Information (PII) in the service layer.
 *
 * These helpers handle:
 * - Null/undefined values (pass-through as ok result)
 * - JSON serialization for complex objects
 * - Result pattern for error handling
 */

import type { Result, OctError } from '@octabits-io/foundation/result';
import { z } from 'zod';
import { encryptHybrid, decryptHybrid } from './encryption.ts';

export interface PiiEncryptionError extends OctError {
  key: 'pii_encryption_error';
}

export interface PiiDecryptionError extends OctError {
  key: 'pii_decryption_error';
}

/**
 * Encrypt a string value for storage using age encryption.
 * Returns ok with null for null/undefined input (pass-through).
 *
 * @param value - The string to encrypt
 * @param recipient - Age recipient (age1...) for encryption
 */
export async function encryptPiiString(
  value: string | null | undefined,
  recipient: string
): Promise<Result<Buffer | null, PiiEncryptionError>> {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  const result = await encryptHybrid(value, recipient);
  if (!result.ok) {
    return {
      ok: false,
      error: { key: 'pii_encryption_error', message: `Failed to encrypt PII: ${result.error.message}` },
    };
  }
  return { ok: true, value: result.value };
}

/**
 * Decrypt a buffer to string using age encryption.
 * Returns ok with null for null input (pass-through).
 *
 * @param encrypted - The encrypted buffer
 * @param identity - Age identity (AGE-SECRET-KEY-1...) for decryption
 */
export async function decryptPiiString(
  encrypted: Buffer | null,
  identity: string
): Promise<Result<string | null, PiiDecryptionError>> {
  if (encrypted === null) {
    return { ok: true, value: null };
  }
  const result = await decryptHybrid(encrypted, identity);
  if (!result.ok) {
    return {
      ok: false,
      error: { key: 'pii_decryption_error', message: `Failed to decrypt PII: ${result.error.message}` },
    };
  }
  return { ok: true, value: result.value };
}

/**
 * Encrypt a JSON-serializable value for storage using age encryption.
 * Returns ok with null for null/undefined input (pass-through).
 *
 * @param value - The value to serialize and encrypt
 * @param recipient - Age recipient (age1...) for encryption
 */
export async function encryptPiiJson<T>(
  value: T | null | undefined,
  recipient: string
): Promise<Result<Buffer | null, PiiEncryptionError>> {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  return encryptPiiString(JSON.stringify(value), recipient);
}

/**
 * Decrypt a buffer to a JSON-parsed value using age encryption.
 * Validates the parsed JSON against the provided Zod schema.
 * Returns ok with null for null input (pass-through).
 *
 * @param encrypted - The encrypted buffer
 * @param identity - Age identity (AGE-SECRET-KEY-1...) for decryption
 * @param schema - Zod schema for validating and typing the decrypted data
 */
export async function decryptPiiJson<T extends z.ZodType>(
  encrypted: Buffer | null,
  identity: string,
  schema: T
): Promise<Result<z.infer<T> | null, PiiDecryptionError>> {
  if (encrypted === null) {
    return { ok: true, value: null };
  }
  const result = await decryptPiiString(encrypted, identity);
  if (!result.ok) {
    return result;
  }
  if (result.value === null) {
    return { ok: true, value: null };
  }
  try {
    const parsed = JSON.parse(result.value);
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: { key: 'pii_decryption_error', message: `Validation failed: ${validated.error.message}` },
      };
    }
    return { ok: true, value: validated.data };
  } catch {
    return {
      ok: false,
      error: { key: 'pii_decryption_error', message: 'Failed to parse decrypted JSON' },
    };
  }
}
