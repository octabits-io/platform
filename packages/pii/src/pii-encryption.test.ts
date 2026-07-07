import { assert, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import * as age from './typage/index.js';
import {
  encryptPiiString,
  decryptPiiString,
  encryptPiiJson,
  decryptPiiJson,
  encryptPiiBytes,
  decryptPiiBytes,
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
    const encrypted = await encryptPiiJson({ wrong: 'shape', name: 'Secret Person' }, recipient);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const result = await decryptPiiJson(encrypted.value, identity, schema);
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('pii_decryption_error');
    expect(result.error.message).toMatch(/failed schema validation \(\d+ issues?\)/);
    // The message must not leak the decrypted object's shape or values.
    expect(result.error.message).not.toContain('wrong');
    expect(result.error.message).not.toContain('age');
    expect(result.error.message).not.toContain('Secret Person');
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

describe('encryptPiiBytes / decryptPiiBytes', () => {
  test('round-trips binary payloads', async () => {
    const payload = new Uint8Array([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);

    const enc = await encryptPiiBytes(payload, recipient);
    assert(enc.ok);
    expect(enc.value).toBeInstanceOf(Buffer);

    const dec = await decryptPiiBytes(enc.value, identity);
    assert(dec.ok);
    assert(dec.value !== null);
    expect(new Uint8Array(dec.value)).toEqual(payload);
  });

  test('passes through null and undefined on encrypt', async () => {
    const encNull = await encryptPiiBytes(null, recipient);
    assert(encNull.ok);
    expect(encNull.value).toBeNull();

    const encUndefined = await encryptPiiBytes(undefined, recipient);
    assert(encUndefined.ok);
    expect(encUndefined.value).toBeNull();
  });

  test('passes through null on decrypt', async () => {
    const dec = await decryptPiiBytes(null, identity);
    assert(dec.ok);
    expect(dec.value).toBeNull();
  });

  test('returns pii_decryption_error for invalid data', async () => {
    const dec = await decryptPiiBytes(Buffer.from('garbage'), identity);
    assert(!dec.ok);
    expect(dec.error.key).toBe('pii_decryption_error');
  });
});
