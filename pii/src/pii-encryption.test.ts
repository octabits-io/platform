import { assert, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import * as age from './typage/index.js';
import {
  encryptPiiString,
  decryptPiiString,
  encryptPiiJson,
  decryptPiiJson,
} from './pii-encryption.ts';

let identity: string;
let recipient: string;

beforeAll(async () => {
  identity = await age.generateIdentity();
  recipient = await age.identityToRecipient(identity);
});

describe('encryptPiiString', () => {
  test('encrypts and returns a buffer', async () => {
    const result = await encryptPiiString('hello@example.com', recipient);
    assert(result.ok);
    expect(result.value).toBeInstanceOf(Buffer);
  });

  test('returns null for null input', async () => {
    const result = await encryptPiiString(null, recipient);
    assert(result.ok);
    expect(result.value).toBeNull();
  });

  test('returns null for undefined input', async () => {
    const result = await encryptPiiString(undefined, recipient);
    assert(result.ok);
    expect(result.value).toBeNull();
  });

  test('returns error with invalid recipient', async () => {
    const result = await encryptPiiString('test', 'bad-recipient');
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('pii_encryption_error');
  });
});

describe('decryptPiiString', () => {
  test('decrypts back to original string', async () => {
    const encrypted = await encryptPiiString('hello@example.com', recipient);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const decrypted = await decryptPiiString(encrypted.value, identity);
    assert(decrypted.ok);
    expect(decrypted.value).toBe('hello@example.com');
  });

  test('returns null for null input', async () => {
    const result = await decryptPiiString(null, identity);
    assert(result.ok);
    expect(result.value).toBeNull();
  });

  test('returns error for non-age data', async () => {
    const result = await decryptPiiString(Buffer.from('not-age-data'), identity);
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('pii_decryption_error');
  });

  test('returns error with wrong identity', async () => {
    const otherIdentity = await age.generateIdentity();

    const encrypted = await encryptPiiString('secret', recipient);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const result = await decryptPiiString(encrypted.value, otherIdentity);
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('pii_decryption_error');
  });

  test('handles empty string', async () => {
    const encrypted = await encryptPiiString('', recipient);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const decrypted = await decryptPiiString(encrypted.value, identity);
    assert(decrypted.ok);
    expect(decrypted.value).toBe('');
  });

  test('handles unicode', async () => {
    const value = 'Ünïcödé 日本語 🔑';
    const encrypted = await encryptPiiString(value, recipient);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const decrypted = await decryptPiiString(encrypted.value, identity);
    assert(decrypted.ok);
    expect(decrypted.value).toBe(value);
  });
});

describe('encryptPiiJson', () => {
  test('encrypts a JSON object', async () => {
    const result = await encryptPiiJson({ name: 'Alice', age: 30 }, recipient);
    assert(result.ok);
    expect(result.value).toBeInstanceOf(Buffer);
  });

  test('returns null for null input', async () => {
    const result = await encryptPiiJson(null, recipient);
    assert(result.ok);
    expect(result.value).toBeNull();
  });

  test('returns null for undefined input', async () => {
    const result = await encryptPiiJson(undefined, recipient);
    assert(result.ok);
    expect(result.value).toBeNull();
  });
});

describe('decryptPiiJson', () => {
  const schema = z.object({ name: z.string(), age: z.number() });

  test('round-trips a JSON object with schema validation', async () => {
    const original = { name: 'Alice', age: 30 };
    const encrypted = await encryptPiiJson(original, recipient);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const decrypted = await decryptPiiJson(encrypted.value, identity, schema);
    assert(decrypted.ok);
    expect(decrypted.value).toEqual(original);
  });

  test('returns null for null input', async () => {
    const result = await decryptPiiJson(null, identity, schema);
    assert(result.ok);
    expect(result.value).toBeNull();
  });

  test('returns error when schema validation fails', async () => {
    const encrypted = await encryptPiiJson({ wrong: 'shape' }, recipient);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const result = await decryptPiiJson(encrypted.value, identity, schema);
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('pii_decryption_error');
    expect(result.error.message).toContain('Validation failed');
  });

  test('returns error for non-JSON string', async () => {
    const encrypted = await encryptPiiString('not-json', recipient);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const result = await decryptPiiJson(encrypted.value, identity, schema);
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('pii_decryption_error');
    expect(result.error.message).toContain('Failed to parse decrypted JSON');
  });

  test('handles arrays', async () => {
    const arraySchema = z.array(z.string());
    const original = ['a', 'b', 'c'];
    const encrypted = await encryptPiiJson(original, recipient);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const decrypted = await decryptPiiJson(encrypted.value, identity, arraySchema);
    assert(decrypted.ok);
    expect(decrypted.value).toEqual(original);
  });
});
