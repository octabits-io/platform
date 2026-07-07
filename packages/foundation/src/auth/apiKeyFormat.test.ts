import { describe, it, expect } from 'vitest';
import { createApiKeyFormat } from './apiKeyFormat.ts';

describe('createApiKeyFormat', () => {
  const format = createApiKeyFormat({ prefix: 'acme_' });

  describe('generation', () => {
    it('issues unique high-entropy ids', () => {
      const ids = new Set(Array.from({ length: 100 }, () => format.generateKeyId()));
      expect(ids.size).toBe(100);
      for (const id of ids) {
        expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(id.length).toBeGreaterThanOrEqual(10);
      }
    });

    it('issues unique high-entropy secrets', () => {
      const secrets = new Set(Array.from({ length: 50 }, () => format.generateSecret()));
      expect(secrets.size).toBe(50);
      for (const s of secrets) {
        expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(s.length).toBeGreaterThanOrEqual(40);
      }
    });
  });

  describe('formatToken / parseToken', () => {
    it('round-trips a freshly generated key', () => {
      const id = format.generateKeyId();
      const secret = format.generateSecret();
      const token = format.formatToken(id, secret);
      expect(token.startsWith('acme_')).toBe(true);
      const parsed = format.parseToken(token);
      expect(parsed).toEqual({ keyId: id, secret });
    });

    it('rejects malformed tokens', () => {
      expect(format.parseToken('')).toBeNull();
      expect(format.parseToken('not_an_api_key')).toBeNull();
      expect(format.parseToken('acme_')).toBeNull();
      expect(format.parseToken('acme_onlyid')).toBeNull(); // missing .secret
      expect(format.parseToken('acme_id.')).toBeNull(); // empty secret
      expect(format.parseToken('acme_$bad$.secret')).toBeNull(); // non-base64url id
      expect(format.parseToken('acme_id.$bad$')).toBeNull(); // non-base64url secret
    });
  });

  describe('isApiKeyToken', () => {
    it('matches only the configured prefix', () => {
      expect(format.isApiKeyToken('acme_abc.def')).toBe(true);
      expect(format.isApiKeyToken('eyJhbGciOiJSUzI1NiJ9.payload.sig')).toBe(false); // a JWT
      expect(format.isApiKeyToken('Bearer acme_x.y')).toBe(false); // header form, not raw token
    });
  });

  describe('deriveKeyPrefix', () => {
    it('produces a publicly visible identifier without leaking the secret', () => {
      const id = 'AbCdEfGhIj';
      expect(format.deriveKeyPrefix(id)).toBe('acme_AbCdEfGhIj');
    });
  });

  describe('hashSecret / verifyHash', () => {
    it('verifies the matching secret', () => {
      const secret = format.generateSecret();
      const hash = format.hashSecret(secret);
      expect(format.verifyHash(secret, hash)).toBe(true);
    });

    it('rejects a wrong secret of any length', () => {
      const secret = format.generateSecret();
      const hash = format.hashSecret(secret);
      expect(format.verifyHash('totally-different', hash)).toBe(false);
      expect(format.verifyHash(secret + 'x', hash)).toBe(false);
      expect(format.verifyHash('', hash)).toBe(false);
    });

    it('rejects a malformed hex hash without throwing', () => {
      expect(format.verifyHash('any-secret', 'not-hex-zzz')).toBe(false);
    });
  });

  describe('prefix parameterization', () => {
    it('isolates tokens by prefix — one format does not accept another prefix', () => {
      const acme = createApiKeyFormat({ prefix: 'acme_' });
      const other = createApiKeyFormat({ prefix: 'zzz_' });
      const token = acme.formatToken(acme.generateKeyId(), acme.generateSecret());
      expect(other.isApiKeyToken(token)).toBe(false);
      expect(other.parseToken(token)).toBeNull();
      expect(acme.parseToken(token)).not.toBeNull();
    });

    it('exposes the configured prefix', () => {
      expect(createApiKeyFormat({ prefix: 'rynt_' }).prefix).toBe('rynt_');
    });
  });
});
