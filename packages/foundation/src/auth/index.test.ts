import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JWTPayload } from 'jose';

import {
  createJwtValidationService,
  type ClaimMapper,
} from './index.ts';

// --- Mock jose ---------------------------------------------------------------
const jwtVerifyMock = vi.fn();
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'MOCK_JWKS'),
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
}));

// --- Test fixtures -----------------------------------------------------------
interface DomainToken {
  userId: string;
  email: string;
}

const claimMapper: ClaimMapper<DomainToken> = (payload: JWTPayload) => {
  const userId = payload.sub;
  if (!userId) return { ok: false, message: 'missing sub' };
  return { ok: true, value: { userId, email: (payload.email as string) ?? '' } };
};

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};

const baseConfig = {
  issuerUrl: 'https://auth.example.com/',
  audience: 'project-123',
  logger: noopLogger,
  claimMapper,
};

function stubDiscoveryOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jwks_uri: 'https://auth.example.com/keys' }),
    })),
  );
}

beforeEach(() => {
  jwtVerifyMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createJwtValidationService', () => {
  describe('extractBearerToken', () => {
    const svc = createJwtValidationService<DomainToken>(baseConfig);
    it('extracts a Bearer token', () => {
      expect(svc.extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    });
    it('returns null for missing/malformed headers', () => {
      expect(svc.extractBearerToken(undefined)).toBeNull();
      expect(svc.extractBearerToken('abc.def.ghi')).toBeNull();
      expect(svc.extractBearerToken('Basic abc')).toBeNull();
    });
  });

  describe('validateAuthorizationHeader', () => {
    it('returns missing_token when header is absent', async () => {
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateAuthorizationHeader(undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('missing_token');
    });
  });

  describe('auth bypass', () => {
    it('returns the injected bypassToken when the secret matches', async () => {
      const bypassToken: DomainToken = { userId: 'e2e', email: 'e2e@example.com' };
      const svc = createJwtValidationService<DomainToken>({
        ...baseConfig,
        authBypassSecret: 'super-secret',
        bypassToken,
      });
      const result = await svc.validateToken('super-secret');
      expect(result).toEqual({ ok: true, value: bypassToken });
      // Never touches jose
      expect(jwtVerifyMock).not.toHaveBeenCalled();
    });

    it('rejects when the secret matches but no bypassToken is configured', async () => {
      const svc = createJwtValidationService<DomainToken>({
        ...baseConfig,
        authBypassSecret: 'super-secret',
      });
      const result = await svc.validateToken('super-secret');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('invalid_token');
    });

    it('does not treat a normal token as the bypass secret', async () => {
      stubDiscoveryOk();
      jwtVerifyMock.mockResolvedValue({ payload: { sub: 'u1', email: 'u1@example.com' } });
      const svc = createJwtValidationService<DomainToken>({
        ...baseConfig,
        authBypassSecret: 'super-secret',
        bypassToken: { userId: 'e2e', email: 'e2e@example.com' },
      });
      const result = await svc.validateToken('a.real.jwt');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.userId).toBe('u1');
    });
  });

  describe('token verification', () => {
    it('verifies with issuer (trailing slash stripped) and audience, then maps claims', async () => {
      stubDiscoveryOk();
      jwtVerifyMock.mockResolvedValue({ payload: { sub: 'user-1', email: 'a@b.com' } });
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateToken('a.real.jwt');
      expect(result).toEqual({ ok: true, value: { userId: 'user-1', email: 'a@b.com' } });
      expect(jwtVerifyMock).toHaveBeenCalledWith('a.real.jwt', 'MOCK_JWKS', {
        issuer: 'https://auth.example.com',
        audience: 'project-123',
        algorithms: expect.arrayContaining(['RS256', 'ES256']),
      });
    });

    it('pins the accepted algorithms to asymmetric families by default', async () => {
      stubDiscoveryOk();
      jwtVerifyMock.mockResolvedValue({ payload: { sub: 'user-1' } });
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      await svc.validateToken('a.real.jwt');
      const options = jwtVerifyMock.mock.calls[0]?.[2] as { algorithms: string[] };
      expect(options.algorithms).not.toContain('HS256');
    });

    it('passes caller-supplied algorithms through to jwtVerify', async () => {
      stubDiscoveryOk();
      jwtVerifyMock.mockResolvedValue({ payload: { sub: 'user-1' } });
      const svc = createJwtValidationService<DomainToken>({ ...baseConfig, algorithms: ['ES256'] });
      await svc.validateToken('a.real.jwt');
      expect(jwtVerifyMock).toHaveBeenCalledWith('a.real.jwt', 'MOCK_JWKS', expect.objectContaining({ algorithms: ['ES256'] }));
    });

    it('returns missing_claims when the claimMapper rejects the payload', async () => {
      stubDiscoveryOk();
      jwtVerifyMock.mockResolvedValue({ payload: { email: 'a@b.com' } }); // no sub
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateToken('a.real.jwt');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('missing_claims');
        expect(result.error.message).toBe('missing sub');
      }
    });

    it('returns expired_token when jose reports expiry via code ERR_JWT_EXPIRED', async () => {
      stubDiscoveryOk();
      const expiredError = Object.assign(new Error('JWT is expired'), { code: 'ERR_JWT_EXPIRED' });
      jwtVerifyMock.mockRejectedValue(expiredError);
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateToken('a.real.jwt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('expired_token');
    });

    it('returns expired_token via the exact "exp" claim message fallback', async () => {
      stubDiscoveryOk();
      jwtVerifyMock.mockRejectedValue(new Error('"exp" claim timestamp check failed'));
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateToken('a.real.jwt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('expired_token');
    });

    it('does NOT classify wrong-issuer errors as expired (jose message contains "iss")', async () => {
      // Regression: `error.message.includes('exp')` matched the "unexpected"
      // in jose's claim-mismatch wording and reported expired_token.
      stubDiscoveryOk();
      const issError = Object.assign(new Error('unexpected "iss" claim value'), {
        code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
      });
      jwtVerifyMock.mockRejectedValue(issError);
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateToken('a.real.jwt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('invalid_token');
    });

    it('returns invalid_token on a generic verification failure', async () => {
      stubDiscoveryOk();
      jwtVerifyMock.mockRejectedValue(new Error('signature verification failed'));
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateToken('a.real.jwt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('invalid_token');
    });
  });

  describe('OIDC discovery failures', () => {
    it('returns jwks_unavailable when discovery fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateToken('a.real.jwt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('jwks_unavailable');
    });

    it('returns jwks_unavailable when discovery responds non-2xx', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateToken('a.real.jwt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('jwks_unavailable');
    });

    it('returns jwks_unavailable when discovery lacks jwks_uri', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
      const svc = createJwtValidationService<DomainToken>(baseConfig);
      const result = await svc.validateToken('a.real.jwt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('jwks_unavailable');
    });
  });
});
