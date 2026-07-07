import { describe, it, expect } from 'vitest';
import type { OctError, Result } from '../result/index.ts';
import { ok, err } from '../result/index.ts';
import {
  createBearerAuthService,
  extractBearerToken,
  type BearerStrategy,
} from './BearerAuthService.ts';

interface Principal {
  id: string;
  via: string;
}

/** A strategy that claims tokens with a given prefix and returns a principal. */
function prefixStrategy(prefix: string, via: string): BearerStrategy<Principal> {
  return {
    matches: (token) => token.startsWith(prefix),
    validate: (token): Result<Principal, OctError> => {
      const id = token.slice(prefix.length);
      if (!id) return err({ key: 'empty_id', message: 'no id after prefix' });
      return ok({ id, via });
    },
  };
}

describe('extractBearerToken', () => {
  it('extracts a Bearer token', () => {
    expect(extractBearerToken('Bearer abc.def')).toBe('abc.def');
  });
  it('returns null for missing/malformed headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('abc.def')).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer a b')).toBeNull();
  });
});

describe('createBearerAuthService', () => {
  it('dispatches to the first strategy whose matches() returns true', async () => {
    const svc = createBearerAuthService<Principal>({
      strategies: [prefixStrategy('key_', 'api-key'), prefixStrategy('jwt_', 'jwt')],
    });
    const result = await svc.validateToken('jwt_user-1');
    expect(result).toEqual(ok({ id: 'user-1', via: 'jwt' }));
  });

  it('honors strategy ordering — an earlier matching strategy wins over a later one', async () => {
    // Both strategies match 'x_...'; the first registered must handle it.
    const svc = createBearerAuthService<Principal>({
      strategies: [prefixStrategy('x_', 'first'), prefixStrategy('x_', 'second')],
    });
    const result = await svc.validateToken('x_abc');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.via).toBe('first');
  });

  it('returns no_matching_strategy when nothing claims the token', async () => {
    const svc = createBearerAuthService<Principal>({
      strategies: [prefixStrategy('key_', 'api-key')],
    });
    const result = await svc.validateToken('jwt_nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('no_matching_strategy');
  });

  it('propagates a strategy validation error verbatim', async () => {
    const svc = createBearerAuthService<Principal>({
      strategies: [prefixStrategy('key_', 'api-key')],
    });
    const result = await svc.validateToken('key_'); // empty id → strategy error
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('empty_id');
  });

  describe('validateAuthorizationHeader', () => {
    const svc = createBearerAuthService<Principal>({
      strategies: [prefixStrategy('jwt_', 'jwt')],
    });

    it('returns missing_token when header is absent or malformed', async () => {
      const absent = await svc.validateAuthorizationHeader(undefined);
      expect(absent.ok).toBe(false);
      if (!absent.ok) expect(absent.error.key).toBe('missing_token');

      const malformed = await svc.validateAuthorizationHeader('Basic zzz');
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.error.key).toBe('missing_token');
    });

    it('extracts then dispatches on a well-formed header', async () => {
      const result = await svc.validateAuthorizationHeader('Bearer jwt_alice');
      expect(result).toEqual(ok({ id: 'alice', via: 'jwt' }));
    });
  });
});
