import { describe, it, expect, vi } from 'vitest';

// Simulate `jose` (an optional peer) not being installed: any attempt to load
// the module — static or dynamic — throws. The non-JWT `./auth` surface must
// remain importable and fully usable regardless.
vi.mock('jose', () => {
  throw new Error("Cannot find package 'jose'");
});

describe('auth module without jose installed', () => {
  it('imports the ./auth entry without touching jose', async () => {
    const mod = await import('./index.ts');
    expect(mod.createApiKeyFormat).toBeTypeOf('function');
    expect(mod.createBearerAuthService).toBeTypeOf('function');
    expect(mod.createJwtValidationService).toBeTypeOf('function');
  });

  it('createApiKeyFormat generates, parses, and verifies keys', async () => {
    const { createApiKeyFormat } = await import('./index.ts');
    const format = createApiKeyFormat({ prefix: 'acme_' });

    const keyId = format.generateKeyId();
    const secret = format.generateSecret();
    const token = format.formatToken(keyId, secret);

    expect(format.isApiKeyToken(token)).toBe(true);
    expect(format.parseToken(token)).toEqual({ keyId, secret });
    expect(format.verifyHash(secret, format.hashSecret(secret))).toBe(true);
  });

  it('createBearerAuthService dispatches strategies', async () => {
    const { ok } = await import('../result/index.ts');
    const { createBearerAuthService } = await import('./index.ts');
    const svc = createBearerAuthService<{ id: string }>({
      strategies: [
        {
          matches: (token) => token.startsWith('key_'),
          validate: (token) => ok({ id: token.slice(4) }),
        },
      ],
    });

    const result = await svc.validateAuthorizationHeader('Bearer key_alice');
    expect(result).toEqual(ok({ id: 'alice' }));
  });

  it('createJwtValidationService can be constructed (jose loads only on validation)', async () => {
    const { createJwtValidationService } = await import('./index.ts');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    const svc = createJwtValidationService<{ userId: string }>({
      issuerUrl: 'https://auth.example.com',
      audience: 'aud',
      logger,
      claimMapper: () => ({ ok: false, message: 'unused' }),
    });

    // Non-jose surface of the service still works…
    expect(svc.extractBearerToken('Bearer abc')).toBe('abc');
    // …while actual validation surfaces the missing peer as a thrown error
    // (vitest wraps the factory throw, so only assert the rejection itself).
    await expect(svc.validateToken('a.b.c')).rejects.toThrow();
  });
});
