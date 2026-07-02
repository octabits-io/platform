import { assert, expect, test, beforeAll } from 'vitest';
import * as age from './typage/index.js';
import { decryptSymmetric, encryptSymmetric, generateSymmetricKey, encryptHybrid, decryptHybrid, encryptHybridBytes, decryptHybridBytes } from './encryption.ts';


test('symetric_enc', () => {
  const symmetricKey = generateSymmetricKey(); // AES-256

  const encString = encryptSymmetric('foobar', symmetricKey);
  expect(encString).toBeDefined();
  assert(encString.ok)
  // Validate it is a buffer
  expect(encString.value).toBeInstanceOf(Buffer);
  expect(encString.value.length).toBeGreaterThan(0);

  const decString = decryptSymmetric(encString.value, symmetricKey);
  expect(decString).toBeDefined();
  assert(decString.ok);
  expect(decString.value).toBe('foobar');
});

// Age encryption test key pair (generated dynamically in tests)
let ageIdentity: string;
let ageRecipient: string;

beforeAll(async () => {
  // Generate age key pair for tests
  ageIdentity = await age.generateIdentity();
  ageRecipient = await age.identityToRecipient(ageIdentity);
});

test('age_enc - hybrid encryption with age', async () => {
  const encStringResult = await encryptHybrid('foobar', ageRecipient);
  expect(encStringResult).toBeDefined();
  assert(encStringResult.ok);

  expect(encStringResult.value).toBeDefined();
  expect(encStringResult.value).toBeInstanceOf(Buffer);

  const decStringResult = await decryptHybrid(encStringResult.value, ageIdentity);
  expect(decStringResult).toBeDefined();
  assert(decStringResult.ok);
  expect(decStringResult.value).toBeDefined();
  expect(decStringResult.value).toBe('foobar');
});

test('age_enc_bytes - hybrid bytes encryption round-trips binary payloads', async () => {
  // Include bytes that are invalid UTF-8 to prove no text decode happens
  const payload = new Uint8Array([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const encResult = await encryptHybridBytes(payload, ageRecipient);
  assert(encResult.ok);
  expect(encResult.value).toBeInstanceOf(Buffer);

  const decResult = await decryptHybridBytes(encResult.value, ageIdentity);
  assert(decResult.ok);
  expect(decResult.value).toBeInstanceOf(Buffer);
  expect(new Uint8Array(decResult.value)).toEqual(payload);
});

test('age_enc_bytes - decryptHybridBytes rejects non-age data', async () => {
  const decResult = await decryptHybridBytes(Buffer.from('not age data'), ageIdentity);
  assert(!decResult.ok);
  expect(decResult.error.key).toBe('invalid_format_error');
});
