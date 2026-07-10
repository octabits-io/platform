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

test('symmetric_enc - encryptSymmetric returns err (not throw) on a wrong-length key', () => {
  const badKey = Buffer.from('too-short');
  const result = encryptSymmetric('foobar', badKey);
  expect(result.ok).toBe(false);
  assert(!result.ok);
  expect(result.error.key).toBe('symmetric_encryption_error');
});

// --- Tamper resistance: any single-bit/byte corruption must yield err, never wrong plaintext ---

test('tamper - flipping a bit in an AES-GCM ciphertext makes decryptSymmetric fail', () => {
  const key = generateSymmetricKey();
  const enc = encryptSymmetric('sensitive-value', key);
  assert(enc.ok);

  const tampered = Buffer.from(enc.value);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01; // flip a bit in the encrypted data region

  const dec = decryptSymmetric(tampered, key);
  expect(dec.ok).toBe(false);
  assert(!dec.ok);
  expect(dec.error.key).toBe('symmetric_encryption_error');
});

test('tamper - flipping a byte in the age header stanza region makes decryption fail', async () => {
  const enc = await encryptHybrid('sensitive-value', ageRecipient);
  assert(enc.ok);

  const tampered = Buffer.from(enc.value);
  // Offset 30 sits inside the "-> X25519 ..." recipient stanza (after the
  // 22-byte "age-encryption.org/v1\n" intro), well before the payload.
  tampered[30] = (tampered[30] ?? 0) ^ 0x01;

  const dec = await decryptHybrid(tampered, ageIdentity);
  expect(dec.ok).toBe(false);
  assert(!dec.ok);
  expect(dec.error.key).toBe('hybrid_decryption_error');
});

test('tamper - flipping a bit in a STREAM payload chunk makes decryption fail', async () => {
  const payload = new Uint8Array(1024).fill(0xab);
  const enc = await encryptHybridBytes(payload, ageRecipient);
  assert(enc.ok);

  const tampered = Buffer.from(enc.value);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01; // last payload byte (inside the chunk's Poly1305 tag region)

  const dec = await decryptHybridBytes(tampered, ageIdentity);
  expect(dec.ok).toBe(false);
  assert(!dec.ok);
  expect(dec.error.key).toBe('hybrid_decryption_error');
});

// --- Regression for the STREAM nonce-carry bug: payloads beyond 256 chunks (16 MiB) ---

test('age_enc_bytes - >16 MiB payload round-trips and chunk 256 does not reuse the chunk-0 nonce', { timeout: 10_000 }, async () => {
  const CHUNK = 64 * 1024;
  const CHUNK_ENC = CHUNK + 16; // + Poly1305 overhead

  // Chunks 0 and 256 carry identical plaintext: with the broken nonce carry
  // (counter stuck at one byte) chunk 256 reused the all-zero nonce and its
  // ciphertext was byte-identical to chunk 0's.
  const block = new Uint8Array(CHUNK);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31) & 0xff;
  const payload = new Uint8Array(257 * CHUNK + 3);
  payload.set(block, 0);
  payload.set(block, 256 * CHUNK);

  const enc = await encryptHybridBytes(payload, ageRecipient);
  assert(enc.ok);

  // Locate the binary payload: the age header ends with the "--- <mac>" line,
  // followed by the 16-byte file-key nonce, then the STREAM ciphertext.
  const macLine = enc.value.indexOf('\n---');
  const headerEnd = enc.value.indexOf(0x0a, macLine + 1);
  const streamStart = headerEnd + 1 + 16;
  const encChunk = (n: number) =>
    enc.value.subarray(streamStart + n * CHUNK_ENC, streamStart + (n + 1) * CHUNK_ENC);
  expect(encChunk(0).equals(encChunk(256))).toBe(false);

  const dec = await decryptHybridBytes(enc.value, ageIdentity);
  assert(dec.ok);
  expect(dec.value.length).toBe(payload.length);
  expect(dec.value.equals(Buffer.from(payload))).toBe(true);
});
