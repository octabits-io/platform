import { assert, describe, expect, test } from 'vitest';
import { createEnvVarMasterKeyProvider, MIN_MASTER_KEY_SOURCE_LENGTH } from './master-key.ts';

describe('createEnvVarMasterKeyProvider', () => {
  const provider = createEnvVarMasterKeyProvider('test-master-key-source-0123456789abcdef');

  test('encrypt returns a buffer', async () => {
    const plaintext = Buffer.from('secret-data-key');
    const result = await provider.encrypt(plaintext);

    assert(result.ok);
    expect(result.value).toBeInstanceOf(Buffer);
    expect(result.value.length).toBeGreaterThan(0);
  });

  test('decrypt recovers the original plaintext', async () => {
    const plaintext = Buffer.from('secret-data-key');
    const encrypted = await provider.encrypt(plaintext);
    assert(encrypted.ok);

    const decrypted = await provider.decrypt(encrypted.value);
    assert(decrypted.ok);
    expect(decrypted.value).toEqual(plaintext);
  });

  test('encrypted output differs from plaintext', async () => {
    const plaintext = Buffer.from('my-data-key');
    const result = await provider.encrypt(plaintext);
    assert(result.ok);

    expect(result.value.equals(plaintext)).toBe(false);
  });

  test('encrypting the same value twice produces different ciphertext (random IV)', async () => {
    const plaintext = Buffer.from('deterministic-test');
    const a = await provider.encrypt(plaintext);
    const b = await provider.encrypt(plaintext);
    assert(a.ok);
    assert(b.ok);

    expect(a.value.equals(b.value)).toBe(false);
  });

  test('decrypt with wrong key returns error', async () => {
    const provider2 = createEnvVarMasterKeyProvider('different-key-fedcba9876543210fedcba98');
    const plaintext = Buffer.from('secret');

    const encrypted = await provider.encrypt(plaintext);
    assert(encrypted.ok);

    const result = await provider2.decrypt(encrypted.value);
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('master_key_error');
    expect(result.error.message).toContain('Failed to decrypt with master key');
  });

  test('decrypt with corrupted data returns error', async () => {
    const corrupted = Buffer.from('not-valid-encrypted-data');
    const result = await provider.decrypt(corrupted);

    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.error.key).toBe('master_key_error');
  });

  test('custom info parameter produces different keys', async () => {
    const source = 'same-source-0123456789abcdef0123456789';
    const providerA = createEnvVarMasterKeyProvider(source, 'info-a');
    const providerB = createEnvVarMasterKeyProvider(source, 'info-b');
    const plaintext = Buffer.from('test');

    const encrypted = await providerA.encrypt(plaintext);
    assert(encrypted.ok);

    const result = await providerB.decrypt(encrypted.value);
    expect(result.ok).toBe(false);
  });

  test('handles empty buffer', async () => {
    const plaintext = Buffer.from('');
    const encrypted = await provider.encrypt(plaintext);
    assert(encrypted.ok);

    const decrypted = await provider.decrypt(encrypted.value);
    assert(decrypted.ok);
    expect(decrypted.value).toEqual(plaintext);
  });

  test('rejects a key source shorter than the minimum length', () => {
    const short = 'x'.repeat(MIN_MASTER_KEY_SOURCE_LENGTH - 1);
    expect(() => createEnvVarMasterKeyProvider(short)).toThrow(/at least 32 characters/);
  });

  test('accepts a key source at exactly the minimum length', () => {
    const exact = 'x'.repeat(MIN_MASTER_KEY_SOURCE_LENGTH);
    expect(() => createEnvVarMasterKeyProvider(exact)).not.toThrow();
  });

  test('handles large payloads', async () => {
    const plaintext = Buffer.from('x'.repeat(10_000));
    const encrypted = await provider.encrypt(plaintext);
    assert(encrypted.ok);

    const decrypted = await provider.decrypt(encrypted.value);
    assert(decrypted.ok);
    expect(decrypted.value).toEqual(plaintext);
  });
});
