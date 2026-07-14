import crypto from 'node:crypto';

/**
 * Constant-time string comparison for secrets — URL path secrets, webhook
 * tokens, HMAC hex/base64 digests, anything an attacker can submit repeatedly
 * and time.
 *
 * `node:crypto`'s `timingSafeEqual` throws on a length mismatch, so callers
 * usually guard it with `a.length === b.length && timingSafeEqual(...)`. That
 * guard short-circuits: a wrong-length candidate returns measurably faster than
 * a right-length one, leaking the secret's length one probe at a time. Length
 * is weak information, but it is free to withhold — and for a variable-length
 * secret it narrows the search space before the first byte is guessed.
 *
 * So both inputs are SHA-256'd first. The digests are always 32 bytes, so
 * `timingSafeEqual` runs over a fixed width on every call and no branch depends
 * on the inputs' lengths. Hashing is not a substitute for the comparison —
 * digests of unequal secrets differ in constant time just as the secrets would.
 * The trailing `a === b` is collision paranoia only: it is reached solely when
 * the digests already matched, so its early-exit timing reveals nothing about a
 * non-matching candidate.
 *
 * Inputs are treated as UTF-8. This is for secrets, not for user-visible text:
 * there is no Unicode normalization, so two strings that render identically but
 * differ in code points compare unequal.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB) && a === b;
}
