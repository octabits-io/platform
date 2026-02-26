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

import { type Result, type OctError, ok, err } from '@octabits-io/foundation/result';
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
    return ok(null);
  }
  const result = await encryptHybrid(value, recipient);
  if (!result.ok) {
    return err({ key: 'pii_encryption_error' as const, message: `Failed to encrypt PII: ${result.error.message}` });
  }
  return ok(result.value);
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
    return ok(null);
  }
  const result = await decryptHybrid(encrypted, identity);
  if (!result.ok) {
    return err({ key: 'pii_decryption_error' as const, message: `Failed to decrypt PII: ${result.error.message}` });
  }
  return ok(result.value);
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
    return ok(null);
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
    return ok(null);
  }
  const result = await decryptPiiString(encrypted, identity);
  if (!result.ok) {
    return result;
  }
  if (result.value === null) {
    return ok(null);
  }
  try {
    const parsed = JSON.parse(result.value);
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      return err({ key: 'pii_decryption_error' as const, message: `Validation failed: ${validated.error.message}` });
    }
    return ok(validated.data);
  } catch {
    return err({ key: 'pii_decryption_error' as const, message: 'Failed to parse decrypted JSON' });
  }
}
