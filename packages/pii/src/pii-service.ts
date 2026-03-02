/**
 * PII Encryption Service
 *
 * Centralized service for encrypting/decrypting Personally Identifiable Information (PII).
 * Encapsulates the encryption keys and provides a clean interface for services that need
 * to handle encrypted PII data.
 *
 * This service is instantiated once with the encryption keys and injected into services
 * that need encryption capabilities, avoiding the need to pass raw keys around.
 *
 * Uses age encryption (X25519 + ChaCha20-Poly1305).
 *
 * Two variants are available:
 * - `createPiiEncryptionOnlyService` - encryption only (requires recipient)
 * - `createPiiEncryptionService` - encryption + decryption (requires both recipient and identity)
 */

import type { Result } from '@octabits-io/foundation/result';
import { z } from 'zod';
import {
  encryptPiiString,
  decryptPiiString,
  encryptPiiJson,
  decryptPiiJson,
  type PiiEncryptionError,
  type PiiDecryptionError,
} from './pii-encryption.ts';

export interface PiiEncryptionOnlyServiceDeps {
  /** Age recipient (age1...) for encryption */
  recipient: string;
}

export interface PiiEncryptionServiceDeps {
  /** Age recipient (age1...) for encryption */
  recipient: string;
  /** Age identity (AGE-SECRET-KEY-1...) for decryption */
  identity: string;
}

/**
 * Creates a PII encryption-only service with the provided recipient.
 * Use this when you only need to encrypt data (e.g., in contexts where decryption is not needed).
 *
 * @param deps.recipient - Age recipient (age1...) for encryption
 */
export function createPiiEncryptionOnlyService({ recipient }: PiiEncryptionOnlyServiceDeps) {
  return {
    /**
     * Encrypt a string value for storage.
     * Returns ok with null for null/undefined input (pass-through).
     */
    encryptString(value: string | null | undefined): Promise<Result<Buffer | null, PiiEncryptionError>> {
      return encryptPiiString(value, recipient);
    },

    /**
     * Encrypt a JSON-serializable value for storage.
     * Returns ok with null for null/undefined input (pass-through).
     */
    encryptJson<T>(value: T | null | undefined): Promise<Result<Buffer | null, PiiEncryptionError>> {
      return encryptPiiJson(value, recipient);
    },
  };
}

export type PiiEncryptionOnlyService = ReturnType<typeof createPiiEncryptionOnlyService>;

/**
 * Creates a PII encryption service with the provided keys.
 * Provides both encryption and decryption capabilities.
 * Extends the encryption-only service with decryption methods.
 *
 * @param deps.recipient - Age recipient (age1...) for encryption
 * @param deps.identity - Age identity (AGE-SECRET-KEY-1...) for decryption
 */
export function createPiiEncryptionService({ recipient, identity }: PiiEncryptionServiceDeps) {
  const encryptionService = createPiiEncryptionOnlyService({ recipient });

  return {
    // Inherit encryption methods from encryption-only service
    ...encryptionService,

    /**
     * Decrypt a buffer to string.
     * Returns ok with null for null input (pass-through).
     */
    decryptString(encrypted: Buffer | null): Promise<Result<string | null, PiiDecryptionError>> {
      return decryptPiiString(encrypted, identity);
    },

    /**
     * Decrypt a buffer to a JSON-parsed value.
     * Validates the parsed JSON against the provided Zod schema.
     * Returns ok with null for null input (pass-through).
     */
    decryptJson<T extends z.ZodType>(
      encrypted: Buffer | null,
      schema: T
    ): Promise<Result<z.infer<T> | null, PiiDecryptionError>> {
      return decryptPiiJson(encrypted, identity, schema);
    },
  };
}

export type PiiEncryptionService = ReturnType<typeof createPiiEncryptionService>;
