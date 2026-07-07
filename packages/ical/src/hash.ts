// TODO(catalog #24): `hashCyrb53` is inlined here as a private, package-local
// copy. Catalog item #24 moves a shared implementation into
// `@octabits-io/foundation`; once it lands, import from there and delete this
// file.

/**
 * cyrb53 — a fast, well-distributed **non-cryptographic** 53-bit string hash.
 *
 * Used here only for change detection (comparing two calendar snapshots to
 * decide whether anything meaningful changed). It is not, and must not be used
 * as, a security or integrity primitive.
 *
 * @param str - Input string to hash.
 * @param seed - Optional seed; the same input + seed always yields the same hash.
 * @returns The hash as a hex string.
 */
export const hashCyrb53 = (str: string, seed = 0): string => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch: number; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};
