import { assert, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import * as age from './typage/index.js';
import { createPiiEncryptionService, createPiiEncryptionOnlyService } from './pii-service.ts';

let identity: string;
let recipient: string;

beforeAll(async () => {
  identity = await age.generateIdentity();
  recipient = await age.identityToRecipient(identity);
});

describe('createPiiEncryptionOnlyService', () => {
  test('encryptString encrypts a value', async () => {
    const svc = createPiiEncryptionOnlyService({ recipient });
    const result = await svc.encryptString('test@email.com');
    assert(result.ok);
    expect(result.value).toBeInstanceOf(Buffer);
  });

  test('encryptString passes through null', async () => {
    const svc = createPiiEncryptionOnlyService({ recipient });
    const result = await svc.encryptString(null);
    assert(result.ok);
    expect(result.value).toBeNull();
  });

  test('encryptString passes through undefined', async () => {
    const svc = createPiiEncryptionOnlyService({ recipient });
    const result = await svc.encryptString(undefined);
    assert(result.ok);
    expect(result.value).toBeNull();
  });

  test('encryptJson encrypts an object', async () => {
    const svc = createPiiEncryptionOnlyService({ recipient });
    const result = await svc.encryptJson({ email: 'test@email.com' });
    assert(result.ok);
    expect(result.value).toBeInstanceOf(Buffer);
  });

  test('encryptJson passes through null', async () => {
    const svc = createPiiEncryptionOnlyService({ recipient });
    const result = await svc.encryptJson(null);
    assert(result.ok);
    expect(result.value).toBeNull();
  });
});

describe('createPiiEncryptionService', () => {
  test('decryptString round-trips with encryptString', async () => {
    const svc = createPiiEncryptionService({ recipient, identity });
    const encrypted = await svc.encryptString('hello@example.com');
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const decrypted = await svc.decryptString(encrypted.value);
    assert(decrypted.ok);
    expect(decrypted.value).toBe('hello@example.com');
  });

  test('decryptString passes through null', async () => {
    const svc = createPiiEncryptionService({ recipient, identity });
    const result = await svc.decryptString(null);
    assert(result.ok);
    expect(result.value).toBeNull();
  });

  test('decryptJson round-trips with encryptJson', async () => {
    const schema = z.object({ email: z.string(), count: z.number() });
    const svc = createPiiEncryptionService({ recipient, identity });
    const original = { email: 'a@b.com', count: 42 };

    const encrypted = await svc.encryptJson(original);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const decrypted = await svc.decryptJson(encrypted.value, schema);
    assert(decrypted.ok);
    expect(decrypted.value).toEqual(original);
  });

  test('decryptJson passes through null', async () => {
    const schema = z.object({ x: z.string() });
    const svc = createPiiEncryptionService({ recipient, identity });
    const result = await svc.decryptJson(null, schema);
    assert(result.ok);
    expect(result.value).toBeNull();
  });

  test('decryptJson returns error on schema mismatch', async () => {
    const svc = createPiiEncryptionService({ recipient, identity });
    const encrypted = await svc.encryptJson({ wrong: 'data' });
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const strict = z.object({ required: z.number() });
    const result = await svc.decryptJson(encrypted.value, strict);
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('pii_decryption_error');
  });

  test('decryptString returns error for corrupted data', async () => {
    const svc = createPiiEncryptionService({ recipient, identity });
    const result = await svc.decryptString(Buffer.from('garbage'));
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('pii_decryption_error');
  });

  test('inherits encryption methods from encryption-only service', async () => {
    const svc = createPiiEncryptionService({ recipient, identity });
    // encryptString and encryptJson should exist
    expect(typeof svc.encryptString).toBe('function');
    expect(typeof svc.encryptJson).toBe('function');
    expect(typeof svc.decryptString).toBe('function');
    expect(typeof svc.decryptJson).toBe('function');
  });

  test('handles unicode in string round-trip', async () => {
    const svc = createPiiEncryptionService({ recipient, identity });
    const value = '日本語テスト 🔐';

    const encrypted = await svc.encryptString(value);
    assert(encrypted.ok);
    assert(encrypted.value !== null);

    const decrypted = await svc.decryptString(encrypted.value);
    assert(decrypted.ok);
    expect(decrypted.value).toBe(value);
  });
});
