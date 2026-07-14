import crypto from 'node:crypto';
import type { JWTPayload } from 'jose';
import type { OctError, Result } from '../result/index.ts';
import { err, ok } from '../result/index.ts';

// =============================================================================
// Types
// =============================================================================

/** No signing key is available for the requested purpose. */
export interface ScopedSigningKeyNotFoundError extends OctError {
  key: 'scoped_signing_key_not_found';
}

/** A well-formed token failed signature/expiry verification. */
export interface ScopedSigningSignatureInvalidError extends OctError {
  key: 'scoped_signing_signature_invalid';
}

/** An invalid `bytes` option was passed to `shortTag`/`verifyShortTag`. */
export interface ScopedSigningInvalidBytesError extends OctError {
  key: 'scoped_signing_invalid_bytes';
}

export type ScopedSigningError =
  | ScopedSigningKeyNotFoundError
  | ScopedSigningSignatureInvalidError
  | ScopedSigningInvalidBytesError;

/**
 * Persistence seam for per-purpose signing keys. The service is agnostic to
 * where keys live — a multi-tenant consumer might back this with a tenant
 * config row, a single-tenant one with a KV table. Keys are stored as a
 * `purpose → base64-key` map.
 */
export interface SigningKeyStore {
  /** Read the persisted `purpose → base64-key` map. Return `{}` when empty. */
  read(): Promise<Record<string, string>>;
  /** Persist the full `purpose → base64-key` map (replaces prior contents). */
  write(keys: Record<string, string>): Promise<void>;
}

interface ScopedSigningServiceBaseConfig {
  /**
   * Opaque scope identifier used as the HKDF salt for domain separation. Not a
   * database column and never interpreted — two different scope strings yield
   * two disjoint key spaces.
   */
  scopeKey: string;
  /** Read/write access to the persisted per-purpose key map. */
  keyStore: SigningKeyStore;
  /**
   * Optional master secret. When present, per-purpose keys are HKDF-derived on
   * the fly (no store round-trip) and can be verified before any lookup. When
   * absent, the service is verify/read-only against `keyStore` — key derivation
   * and JWT signing (which auto-provisions) are unavailable.
   */
  masterSecret?: string;
}

/**
 * Default derivation: the HKDF `info` string is built from `infoPrefix` in a
 * safe, length-prefixed format. Use this everywhere except when adopting a
 * legacy key space (see {@link ScopedSigningCustomDerivationConfig}).
 */
interface ScopedSigningDefaultDerivationConfig extends ScopedSigningServiceBaseConfig {
  /**
   * Domain-separation prefix baked into every HKDF info string, so keys derived
   * by one product/context can never collide with another's. Both `infoPrefix`
   * and `purpose` are length-prefixed in the info string
   * (`${len}:${infoPrefix}|${len}:${purpose}|signing-key-v1`) so distinct
   * (prefix, purpose) pairs can never encode to the same bytes.
   */
  infoPrefix: string;
  deriveInfo?: never;
}

/**
 * Custom derivation: `deriveInfo` fully controls the HKDF `info` string, so
 * `infoPrefix` is neither needed nor allowed. Supply this **only** to reproduce
 * a legacy consumer's exact derived bytes — i.e. to adopt this service without
 * a key-rotation event, keeping every already-issued signature verifiable.
 *
 * WARNING: a custom format with two or more variable segments MUST length-
 * prefix each of them, or distinct inputs can encode to the same `info` bytes
 * and derive identical keys (the collision the default format guards against).
 * A format with a single variable segment (just `purpose`) is unambiguous.
 */
interface ScopedSigningCustomDerivationConfig extends ScopedSigningServiceBaseConfig {
  infoPrefix?: never;
  deriveInfo: (purpose: string) => string;
}

export type ScopedSigningServiceConfig =
  | ScopedSigningDefaultDerivationConfig
  | ScopedSigningCustomDerivationConfig;

/**
 * Default truncation for `shortTag` — 12 bytes / 96-bit tag (24 hex chars).
 * HMAC truncation to ≥80 bits is standard (RFC 2104 §5); 96 bits keeps a
 * comfortable margin under length-constrained identifiers.
 */
const DEFAULT_TAG_BYTES = 12;

/** Valid `bytes` range for `shortTag`/`verifyShortTag`: 1..32 (SHA-256 digest size). */
function validateTagBytes(bytes: number): ScopedSigningInvalidBytesError | null {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 32) {
    return {
      key: 'scoped_signing_invalid_bytes',
      message: `shortTag bytes must be an integer between 1 and 32, got: ${bytes}`,
    };
  }
  return null;
}

// =============================================================================
// Service Factory
// =============================================================================

/**
 * Generic per-scope, per-purpose signing service.
 *
 * The single mechanism for "sign and verify stuff under an opaque scope" — so
 * no consumer re-implements HMAC/JWT crypto, key derivation, or constant-time
 * comparison. Each caller picks a `purpose` string; every purpose gets its own
 * 256-bit key with cryptographic domain separation via HKDF info strings.
 *
 * Two key-access modes, transparent to callers:
 * - **With `masterSecret`**: keys are HKDF-derived on the fly — no store
 *   round-trip, so signatures can be verified *before* any lookup.
 * - **Without `masterSecret`**: read the key from `keyStore` (verify-only). JWT
 *   signing auto-provisions the key there, so a later read-only path can verify.
 *
 * Primitives:
 * - `shortTag` / `verifyShortTag` — truncated hex HMAC-SHA256 (default 96-bit /
 *   12 bytes, truncated at the byte level then hex-encoded). For length-
 *   constrained routing tags.
 * - `hmac` / `verifyHmac` — full-length detached base64url HMAC-SHA256.
 * - `signJwt` / `verifyJwt` — self-contained HS256 tokens with expiry. The JWT
 *   half loads `jose` lazily (an optional peer): non-JWT primitives work even
 *   when `jose` is not installed.
 */
export function createScopedSigningService(config: ScopedSigningServiceConfig) {
  const { scopeKey, keyStore, masterSecret } = config;

  // Resolve the HKDF info-string builder once. A caller-supplied `deriveInfo`
  // reproduces a legacy key space verbatim; otherwise fall back to the safe,
  // length-prefixed default. Length-prefixing both variable parts keeps them
  // disjoint — a bare `${infoPrefix}-${purpose}` is delimiter-ambiguous, so
  // ('a', 'b-c') and ('a-b', 'c') would encode to the same bytes.
  const buildInfo: (purpose: string) => string = config.deriveInfo
    ? config.deriveInfo
    : (purpose) =>
        `${config.infoPrefix.length}:${config.infoPrefix}|${purpose.length}:${purpose}|signing-key-v1`;

  /**
   * Derive a per-scope, per-purpose 256-bit signing key from the master secret
   * via HKDF-SHA256. Uses `scopeKey` as salt and `purpose` in the info string
   * for cryptographic domain separation. Requires a master secret.
   */
  function deriveKey(purpose: string): Buffer {
    if (!masterSecret) throw new Error('Key derivation requires a master secret');
    const info = Buffer.from(buildInfo(purpose));
    return Buffer.from(crypto.hkdfSync('sha256', masterSecret, scopeKey, info, 32));
  }

  // Serializes provisioning read-modify-write cycles within this process so
  // two concurrent `ensureProvisioned` calls cannot read the same map and
  // clobber each other's purpose on write. Rejections are swallowed on the
  // chain itself (each caller still sees its own task's rejection).
  let provisionChain: Promise<void> = Promise.resolve();

  /**
   * Ensure a signing key for the given purpose is stored in `keyStore`. Derives
   * and stores the key if not already present. Preserves existing keys for
   * other purposes.
   *
   * In-process calls are serialized (see `provisionChain`). Cross-process races
   * against the same store can still drop a concurrently-added purpose, but are
   * recoverable: with `masterSecret` set, keys are deterministically re-derived,
   * so the next `ensureProvisioned` for the dropped purpose restores the exact
   * same key bytes.
   */
  function ensureProvisioned(purpose: string): Promise<void> {
    const task = provisionChain.then(async () => {
      const map = await keyStore.read();
      if (map[purpose]) return;

      const key = deriveKey(purpose);
      await keyStore.write({ ...map, [purpose]: key.toString('base64') });
    });
    provisionChain = task.catch(() => {});
    return task;
  }

  /**
   * Retrieve the signing key for a given purpose from `keyStore`. Works without
   * `masterSecret` (read-only verification path).
   */
  async function getKey(purpose: string): Promise<Result<Uint8Array, ScopedSigningError>> {
    const map = await keyStore.read();
    const keyBase64 = map[purpose];

    if (!keyBase64) {
      return err({
        key: 'scoped_signing_key_not_found',
        message: `No signing key configured for purpose: ${purpose}`,
      });
    }

    return ok(new Uint8Array(Buffer.from(keyBase64, 'base64')));
  }

  /**
   * Resolve raw key bytes for a purpose. Prefers HKDF derivation when a master
   * secret is available (no store round-trip — usable before any lookup),
   * otherwise falls back to the key stored in `keyStore`. Both paths yield
   * identical bytes, since provisioning stores the derived key verbatim.
   */
  async function resolveKey(purpose: string): Promise<Result<Uint8Array, ScopedSigningError>> {
    if (masterSecret) return ok(new Uint8Array(deriveKey(purpose)));
    return getKey(purpose);
  }

  function computeHmac(message: string, key: Uint8Array): string {
    return crypto.createHmac('sha256', key).update(message, 'utf8').digest('base64url');
  }

  /**
   * Compute a base64url HMAC-SHA256 of `message` under the purpose key.
   */
  async function hmac(purpose: string, message: string): Promise<Result<string, ScopedSigningError>> {
    const key = await resolveKey(purpose);
    if (!key.ok) return key;
    return ok(computeHmac(message, key.value));
  }

  /**
   * Constant-time verification of a base64url HMAC-SHA256 signature. Returns
   * `ok(false)` for a well-formed-but-wrong signature, and an error only when
   * no key is available.
   */
  async function verifyHmac(
    purpose: string,
    message: string,
    signature: string,
  ): Promise<Result<boolean, ScopedSigningError>> {
    const key = await resolveKey(purpose);
    if (!key.ok) return key;
    const expected = Buffer.from(computeHmac(message, key.value));
    const provided = Buffer.from(signature);
    const valid = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
    return ok(valid);
  }

  function computeShortTag(message: string, key: Uint8Array, bytes: number): string {
    // Truncate the raw digest at the byte level, *then* hex-encode — cleaner and
    // unambiguous vs. slicing the encoded string.
    return crypto.createHmac('sha256', key).update(message, 'utf8').digest().subarray(0, bytes).toString('hex');
  }

  /**
   * Compute a short, length-constrained hex tag (truncated HMAC-SHA256) over
   * `message`. Defaults to a 12-byte / 96-bit tag (24 lowercase hex chars). For
   * embedding in length-bounded identifiers.
   */
  async function shortTag(
    purpose: string,
    message: string,
    opts: { bytes?: number } = {},
  ): Promise<Result<string, ScopedSigningError>> {
    const bytes = opts.bytes ?? DEFAULT_TAG_BYTES;
    const bytesError = validateTagBytes(bytes);
    if (bytesError) return err(bytesError);
    const key = await resolveKey(purpose);
    if (!key.ok) return key;
    return ok(computeShortTag(message, key.value, bytes));
  }

  /**
   * Constant-time verification of a `shortTag`. Case-insensitive (hex), so a tag
   * that round-tripped through an upper/mixed-case channel still verifies. The
   * `bytes` must match what produced the tag. Returns `ok(false)` for a
   * well-formed-but-wrong tag; an error only when no key is available.
   */
  async function verifyShortTag(
    purpose: string,
    message: string,
    tag: string,
    opts: { bytes?: number } = {},
  ): Promise<Result<boolean, ScopedSigningError>> {
    // Reject invalid bytes up front — with bytes: 0 an empty expected tag
    // would otherwise "verify" against an empty provided tag.
    const bytes = opts.bytes ?? DEFAULT_TAG_BYTES;
    const bytesError = validateTagBytes(bytes);
    if (bytesError) return err(bytesError);
    const key = await resolveKey(purpose);
    if (!key.ok) return key;
    const expected = Buffer.from(computeShortTag(message, key.value, bytes));
    const provided = Buffer.from(tag.toLowerCase());
    const valid = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
    return ok(valid);
  }

  /**
   * Sign a self-contained JWT (HS256) under the purpose key. With a master
   * secret, auto-provisions the derived key into `keyStore` so verify-only paths
   * (no master secret) can read it. Without a master secret it signs using the
   * already-stored key; an unprovisioned purpose returns
   * `scoped_signing_key_not_found` rather than throwing. Callers own the payload
   * shape. Loads `jose` lazily.
   */
  async function signJwt(
    purpose: string,
    payload: JWTPayload,
    opts: { expiresAt: Date },
  ): Promise<Result<string, ScopedSigningError>> {
    // Auto-provision only when a master secret is available to derive the key.
    // In verify/read-only mode (no master secret) signing still works for an
    // already-provisioned purpose — `resolveKey` reads the stored key. An
    // unprovisioned purpose surfaces as a `scoped_signing_key_not_found`
    // Result instead of letting `deriveKey` throw and escape the Result
    // contract.
    if (masterSecret) await ensureProvisioned(purpose);
    const key = await resolveKey(purpose);
    if (!key.ok) return key;

    const { SignJWT } = await import('jose');
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(opts.expiresAt)
      .setIssuedAt()
      .sign(key.value);

    return ok(token);
  }

  /**
   * Verify a JWT (HS256) under the purpose key and return its decoded payload.
   * Validates signature and expiry; callers validate domain claims themselves.
   * Loads `jose` lazily.
   */
  async function verifyJwt(
    purpose: string,
    token: string,
  ): Promise<Result<JWTPayload, ScopedSigningError>> {
    const key = await resolveKey(purpose);
    if (!key.ok) return key;

    try {
      const { jwtVerify } = await import('jose');
      // Pin the algorithm: this service only ever signs HS256.
      const { payload } = await jwtVerify(token, key.value, { algorithms: ['HS256'] });
      return ok(payload);
    } catch {
      return err({ key: 'scoped_signing_signature_invalid', message: 'Invalid or expired token' });
    }
  }

  return { deriveKey, ensureProvisioned, getKey, shortTag, verifyShortTag, hmac, verifyHmac, signJwt, verifyJwt };
}

export type ScopedSigningService = ReturnType<typeof createScopedSigningService>;
