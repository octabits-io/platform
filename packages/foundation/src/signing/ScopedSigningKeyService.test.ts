import { describe, it, expect } from 'vitest';
import {
  createScopedSigningService,
  type SigningKeyStore,
} from './index.ts';

/** In-memory `SigningKeyStore` for exercising lazy-provisioning semantics. */
function memoryStore(initial: Record<string, string> = {}): SigningKeyStore & {
  snapshot: () => Record<string, string>;
  reads: () => number;
  writes: () => number;
} {
  let map: Record<string, string> = { ...initial };
  let reads = 0;
  let writes = 0;
  return {
    read: async () => {
      reads++;
      return { ...map };
    },
    write: async (keys) => {
      writes++;
      map = { ...keys };
    },
    snapshot: () => ({ ...map }),
    reads: () => reads,
    writes: () => writes,
  };
}

const MASTER = 'a-very-long-master-secret-for-hkdf-derivation';

describe('createScopedSigningService', () => {
  describe('HKDF key derivation', () => {
    it('is deterministic for identical (infoPrefix, scopeKey, purpose, masterSecret)', () => {
      const a = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      const b = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      expect(a.deriveKey('email').toString('base64')).toBe(b.deriveKey('email').toString('base64'));
    });

    it('domain-separates by purpose, scopeKey, and infoPrefix', () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      const other = createScopedSigningService({ infoPrefix: 'other', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      const scope2 = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's2', keyStore: memoryStore(), masterSecret: MASTER });

      const base = svc.deriveKey('email').toString('base64');
      expect(svc.deriveKey('booking').toString('base64')).not.toBe(base); // different purpose
      expect(scope2.deriveKey('email').toString('base64')).not.toBe(base); // different scopeKey
      expect(other.deriveKey('email').toString('base64')).not.toBe(base); // different infoPrefix
    });

    it('throws when deriving without a master secret', () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore() });
      expect(() => svc.deriveKey('email')).toThrow(/master secret/i);
    });

    it('is not delimiter-ambiguous across (infoPrefix, purpose) boundaries', () => {
      // Regression: with a plain `${infoPrefix}-${purpose}` info string,
      // ('a', 'b-c') and ('a-b', 'c') encoded identically and derived the
      // same key. Length-prefixing both parts keeps them disjoint.
      const first = createScopedSigningService({ infoPrefix: 'a', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      const second = createScopedSigningService({ infoPrefix: 'a-b', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      expect(first.deriveKey('b-c').toString('base64')).not.toBe(second.deriveKey('c').toString('base64'));
    });
  });

  describe('hmac / verifyHmac', () => {
    it('round-trips and rejects tampered messages and signatures', async () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      const sig = await svc.hmac('email', 'hello');
      expect(sig.ok).toBe(true);
      if (!sig.ok) return;

      expect(await svc.verifyHmac('email', 'hello', sig.value)).toEqual({ ok: true, value: true });
      expect(await svc.verifyHmac('email', 'tampered', sig.value)).toEqual({ ok: true, value: false });
      expect(await svc.verifyHmac('email', 'hello', sig.value + 'x')).toEqual({ ok: true, value: false });
      // A different purpose derives a different key → verification fails.
      expect(await svc.verifyHmac('booking', 'hello', sig.value)).toEqual({ ok: true, value: false });
    });
  });

  describe('shortTag / verifyShortTag', () => {
    it('round-trips (case-insensitive) and rejects wrong tags', async () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      const tag = await svc.shortTag('reply', 'conv-123');
      expect(tag.ok).toBe(true);
      if (!tag.ok) return;
      expect(tag.value).toMatch(/^[0-9a-f]{24}$/); // default 12 bytes → 24 hex chars

      expect(await svc.verifyShortTag('reply', 'conv-123', tag.value)).toEqual({ ok: true, value: true });
      expect(await svc.verifyShortTag('reply', 'conv-123', tag.value.toUpperCase())).toEqual({ ok: true, value: true });
      expect(await svc.verifyShortTag('reply', 'conv-999', tag.value)).toEqual({ ok: true, value: false });
    });

    it('honors a custom byte length', async () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      const tag = await svc.shortTag('reply', 'x', { bytes: 6 });
      if (!tag.ok) throw new Error('expected ok');
      expect(tag.value).toHaveLength(12); // 6 bytes → 12 hex chars
      expect(await svc.verifyShortTag('reply', 'x', tag.value, { bytes: 6 })).toEqual({ ok: true, value: true });
    });

    it('rejects out-of-range bytes — verify with bytes: 0 must not return ok(true)', async () => {
      // Regression: bytes: 0 produced an empty expected tag, and an empty
      // provided tag "verified" against it via zero-length timingSafeEqual.
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });

      for (const bytes of [0, -1, 33, 1.5]) {
        const tag = await svc.shortTag('reply', 'conv-1', { bytes });
        expect(tag.ok).toBe(false);
        if (!tag.ok) expect(tag.error.key).toBe('scoped_signing_invalid_bytes');

        const verified = await svc.verifyShortTag('reply', 'conv-1', '', { bytes });
        expect(verified.ok).toBe(false);
        if (!verified.ok) expect(verified.error.key).toBe('scoped_signing_invalid_bytes');
      }

      // An empty tag with valid bytes is simply wrong, not valid.
      expect(await svc.verifyShortTag('reply', 'conv-1', '')).toEqual({ ok: true, value: false });
    });
  });

  describe('JWT sign / verify', () => {
    it('signs and verifies a round-trip token', async () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      const signed = await svc.signJwt('booking', { bookingId: 'b-1' }, { expiresAt: new Date(Date.now() + 60_000) });
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;

      const verified = await svc.verifyJwt('booking', signed.value);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.value.bookingId).toBe('b-1');
    });

    it('rejects a tampered/foreign token with signature_invalid', async () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore(), masterSecret: MASTER });
      const signed = await svc.signJwt('booking', { bookingId: 'b-1' }, { expiresAt: new Date(Date.now() + 60_000) });
      if (!signed.ok) throw new Error('expected ok');

      const bad = await svc.verifyJwt('booking', signed.value + 'tamper');
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.key).toBe('scoped_signing_signature_invalid');

      // Verifying under a different purpose (different key) also fails.
      const wrongPurpose = await svc.verifyJwt('email', signed.value);
      expect(wrongPurpose.ok).toBe(false);
    });
  });

  describe('keyStore lazy-generation semantics', () => {
    it('auto-provisions the derived key into the store on first signJwt', async () => {
      const store = memoryStore();
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: store, masterSecret: MASTER });

      expect(store.snapshot()).toEqual({});
      await svc.signJwt('booking', { x: 1 }, { expiresAt: new Date(Date.now() + 60_000) });

      const stored = store.snapshot();
      expect(Object.keys(stored)).toEqual(['booking']);
      // Stored bytes are the HKDF-derived key verbatim.
      expect(stored.booking).toBe(svc.deriveKey('booking').toString('base64'));
    });

    it('does not re-provision or overwrite an existing purpose key', async () => {
      const store = memoryStore();
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: store, masterSecret: MASTER });

      await svc.signJwt('booking', { x: 1 }, { expiresAt: new Date(Date.now() + 60_000) });
      const writesAfterFirst = store.writes();
      await svc.signJwt('booking', { x: 2 }, { expiresAt: new Date(Date.now() + 60_000) });
      expect(store.writes()).toBe(writesAfterFirst); // no second write for the same purpose
    });

    it('serializes concurrent provisioning so no purpose is dropped', async () => {
      // Regression: two concurrent ensureProvisioned calls both read the same
      // (empty) map; the second write clobbered the first purpose.
      const store = memoryStore();
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: store, masterSecret: MASTER });

      await Promise.all([
        svc.ensureProvisioned('booking'),
        svc.ensureProvisioned('email'),
        svc.ensureProvisioned('reply'),
      ]);

      expect(Object.keys(store.snapshot()).sort()).toEqual(['booking', 'email', 'reply']);
    });

    it('lets a read-only service (no masterSecret) verify what a provisioning service wrote', async () => {
      const store = memoryStore();
      const signer = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: store, masterSecret: MASTER });
      const token = await signer.signJwt('booking', { bookingId: 'b-1' }, { expiresAt: new Date(Date.now() + 60_000) });
      if (!token.ok) throw new Error('expected ok');

      // Verifier shares the same store but has no master secret — reads the key.
      const verifier = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: store });
      const verified = await verifier.verifyJwt('booking', token.value);
      expect(verified.ok).toBe(true);
    });

    it('returns key_not_found when no masterSecret and the purpose is unprovisioned', async () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore() });
      const result = await svc.hmac('email', 'msg');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('scoped_signing_key_not_found');
    });
  });

  describe('read-only mode (no masterSecret) never leaks a thrown Error', () => {
    // Regression: signing an unprovisioned purpose without a master secret used
    // to reach `ensureProvisioned` → `deriveKey`, throwing 'Key derivation
    // requires a master secret' and escaping the `Result` contract. Every
    // Result-returning op must resolve to a `scoped_signing_key_not_found`
    // Result instead of rejecting.
    it('signJwt on an unprovisioned purpose resolves to key_not_found (does not reject)', async () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore() });
      const result = await svc.signJwt('booking', { bookingId: 'b-1' }, { expiresAt: new Date(Date.now() + 60_000) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('scoped_signing_key_not_found');
    });

    it('hmac / shortTag on an unprovisioned purpose resolve to key_not_found', async () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore() });

      const mac = await svc.hmac('email', 'msg');
      expect(mac.ok).toBe(false);
      if (!mac.ok) expect(mac.error.key).toBe('scoped_signing_key_not_found');

      const tag = await svc.shortTag('reply', 'conv-1');
      expect(tag.ok).toBe(false);
      if (!tag.ok) expect(tag.error.key).toBe('scoped_signing_key_not_found');
    });

    it('verify flows on an unprovisioned purpose resolve to key_not_found', async () => {
      const svc = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: memoryStore() });

      const vmac = await svc.verifyHmac('email', 'msg', 'sig');
      expect(vmac.ok).toBe(false);
      if (!vmac.ok) expect(vmac.error.key).toBe('scoped_signing_key_not_found');

      const vtag = await svc.verifyShortTag('reply', 'conv-1', 'deadbeef');
      expect(vtag.ok).toBe(false);
      if (!vtag.ok) expect(vtag.error.key).toBe('scoped_signing_key_not_found');

      const vjwt = await svc.verifyJwt('booking', 'not.a.token');
      expect(vjwt.ok).toBe(false);
      if (!vjwt.ok) expect(vjwt.error.key).toBe('scoped_signing_key_not_found');
    });

    it('signs and verifies under an already-provisioned key without a masterSecret', async () => {
      const store = memoryStore();
      const signer = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: store, masterSecret: MASTER });
      // Provision the purpose key via the master-secret signer.
      const seeded = await signer.signJwt('booking', { bookingId: 'seed' }, { expiresAt: new Date(Date.now() + 60_000) });
      if (!seeded.ok) throw new Error('expected ok');

      // Read-only service (no masterSecret) can now sign under the stored key.
      const readOnly = createScopedSigningService({ infoPrefix: 'acme', scopeKey: 's1', keyStore: store });
      const signed = await readOnly.signJwt('booking', { bookingId: 'b-1' }, { expiresAt: new Date(Date.now() + 60_000) });
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;

      const verified = await readOnly.verifyJwt('booking', signed.value);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.value.bookingId).toBe('b-1');
    });
  });
});
