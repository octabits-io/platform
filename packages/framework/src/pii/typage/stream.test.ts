import { describe, expect, test } from 'vitest';
import { incNonce, encryptSTREAM, decryptSTREAM } from './stream.ts';

const CHUNK_SIZE = 64 * 1024;
const CHUNK_OVERHEAD = 16;

/** Expected nonce after `n` increments: `n` as an 11-byte big-endian counter + zero flag byte. */
function nonceForChunk(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  let rest = n;
  for (let i = 10; i >= 0 && rest > 0; i--) {
    nonce[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return nonce;
}

async function pump(ts: TransformStream<Uint8Array, Uint8Array>, input: Uint8Array): Promise<Uint8Array> {
  const reader = ts.readable.getReader();
  const chunks: Uint8Array[] = [];
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  const writer = ts.writable.getWriter();
  await writer.write(input);
  await writer.close();
  await drained;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

describe('incNonce — STREAM chunk counter', () => {
  test('carry propagates past the first byte (chunks 255/256/257 get distinct, correct nonces)', () => {
    const nonce = new Uint8Array(12);
    const seen = new Map<number, Uint8Array>();
    for (let n = 1; n <= 257; n++) {
      incNonce(nonce);
      if (n === 255 || n === 256 || n === 257) seen.set(n, nonce.slice());
    }

    // Upstream typage semantics: big-endian counter over bytes 0..10,
    // incremented from index length-2 (=10) towards 0; byte 11 is the
    // final-chunk flag and never touched by the counter.
    expect(seen.get(255)).toEqual(nonceForChunk(255)); // [...0, 255, 0]
    expect(seen.get(256)).toEqual(nonceForChunk(256)); // [...0, 1, 0, 0] — carry into byte 9
    expect(seen.get(257)).toEqual(nonceForChunk(257)); // [...0, 1, 1, 0]

    // The regression: chunk 256 must NOT reuse the all-zero chunk-0 nonce.
    expect(seen.get(256)).not.toEqual(new Uint8Array(12));
    expect(seen.get(256)).not.toEqual(seen.get(255));
  });

  test('does not disturb the final-chunk flag byte during carry', () => {
    const nonce = new Uint8Array(12);
    nonce[10] = 0xff;
    incNonce(nonce);
    expect(nonce[9]).toBe(1);
    expect(nonce[10]).toBe(0);
    expect(nonce[11]).toBe(0);
  });

  test('throws on full counter overflow like upstream typage', () => {
    const nonce = new Uint8Array(12);
    nonce.fill(0xff, 0, 11); // counter fully saturated, flag byte untouched
    expect(() => incNonce(nonce)).toThrow('STREAM: nonce overflow');
  });
});

describe('STREAM encrypt/decrypt beyond the 256-chunk boundary', () => {
  test('chunk 256 is encrypted under a different nonce than chunk 0', async () => {
    // Chunk 0 and chunk 256 carry IDENTICAL plaintext. With the broken carry
    // (counter effectively one byte) chunk 256 reused the all-zero nonce and
    // produced a byte-identical ciphertext block — a catastrophic nonce reuse.
    const key = new Uint8Array(32).fill(7);
    const block = new Uint8Array(CHUNK_SIZE);
    for (let i = 0; i < block.length; i++) block[i] = i & 0xff;

    const plaintext = new Uint8Array(257 * CHUNK_SIZE + 5);
    plaintext.set(block, 0); // chunk 0
    plaintext.set(block, 256 * CHUNK_SIZE); // chunk 256

    const ciphertext = await pump(encryptSTREAM(key), plaintext);

    // Compare via Buffer.equals — vitest deep-equality on multi-megabyte
    // typed arrays enumerates every index and exhausts the heap.
    const encChunk = (n: number) =>
      Buffer.from(ciphertext.subarray(n * (CHUNK_SIZE + CHUNK_OVERHEAD), (n + 1) * (CHUNK_SIZE + CHUNK_OVERHEAD)));
    expect(encChunk(0).equals(encChunk(256))).toBe(false);

    const roundTripped = await pump(decryptSTREAM(key), ciphertext);
    expect(roundTripped.length).toBe(plaintext.length);
    expect(Buffer.from(roundTripped).equals(Buffer.from(plaintext))).toBe(true);
  });
});
