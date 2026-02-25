import { assert, expect, test, beforeAll } from 'vitest';
import * as age from './typage/index.js';
import { decryptSymmetric, encryptSymmetric, generateSymmetricKey, encryptHybrid, decryptHybrid } from './encryption.ts';


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
