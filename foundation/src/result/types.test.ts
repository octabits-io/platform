import { describe, it, expect, expectTypeOf } from 'vitest';
import type { Result } from './types.ts';
import { tryCatch, type OctError, type OctErrorWithKey, type OctExceptionError } from './error.ts';

// Helper to create ok/error results (mirrors real usage patterns)
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <E = OctError>(error: E): Result<never, E> => ({ ok: false, error });

describe('Result<T, E>', () => {
  describe('ok variant', () => {
    it('holds a value when ok is true', () => {
      const result: Result<number> = ok(42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it('works with complex value types', () => {
      const result: Result<{ id: string; items: number[] }> = ok({
        id: 'abc',
        items: [1, 2, 3],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('abc');
        expect(result.value.items).toEqual([1, 2, 3]);
      }
    });
  });

  describe('error variant', () => {
    it('holds an OctError by default when ok is false', () => {
      const result: Result<string> = err({ key: 'not_found', message: 'Missing' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('not_found');
        expect(result.error.message).toBe('Missing');
      }
    });

    it('works with custom error types', () => {
      type MyError = { key: 'custom'; message: string; code: number };
      const result: Result<string, MyError> = err({
        key: 'custom',
        message: 'fail',
        code: 500,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(500);
      }
    });
  });

  describe('discriminated union narrowing', () => {
    it('narrows to value branch when ok is true', () => {
      const result: Result<string> = ok('hello');
      if (result.ok) {
        // After narrowing, .value is accessible and .error is not
        expect(result.value).toBe('hello');
        expect((result as any).error).toBeUndefined();
      }
    });

    it('narrows to error branch when ok is false', () => {
      const result: Result<string> = err({ key: 'fail', message: 'oops' });
      if (!result.ok) {
        expect(result.error.key).toBe('fail');
        expect((result as any).value).toBeUndefined();
      }
    });

    it('works in exhaustive switch-like patterns', () => {
      function handle(result: Result<number>): string {
        if (result.ok) {
          return `value: ${result.value}`;
        }
        return `error: ${result.error.key}`;
      }

      expect(handle(ok(1))).toBe('value: 1');
      expect(handle(err({ key: 'x', message: 'y' }))).toBe('error: x');
    });
  });

  describe('type-level behavior', () => {
    it('defaults E to OctError when omitted', () => {
      const result: Result<string> = err({ key: 'k', message: 'm' });
      if (!result.ok) {
        // E defaults to OctError which has key + message
        expectTypeOf(result.error).toExtend<OctError>();
      }
    });

    it('defaults T to never when omitted', () => {
      // Result with no type args: Result<never, OctError>
      // The ok branch is unreachable since value would be `never`
      const result: Result = err({ key: 'k', message: 'm' });
      expect(result.ok).toBe(false);
    });
  });
});

describe('error propagation', () => {
  // Unsafe — may throw
  function unsafe(n: number): number {
    if (n % 2 === 1) throw new Error('boom');
    return n;
  }

  type DomainError = OctErrorWithKey<'domain'> & { detail: string };

  // Safe — returns errors as values
  function safe(n: number): Result<number, DomainError> {
    if (n % 3 === 1) {
      return { ok: false, error: { key: 'domain', message: 'bad input', detail: 'odd-mod-3' } };
    }
    return { ok: true, value: n };
  }

  // Composes both, propagating errors via early return
  function pipeline(n: number): Result<number, OctExceptionError | DomainError> {
    const step1 = tryCatch(() => unsafe(n));
    if (!step1.ok) return step1;

    const step2 = safe(step1.value);
    if (!step2.ok) return step2;

    return step2;
  }

  it('tryCatch captures thrown exception as Result', () => {
    const result = tryCatch(() => unsafe(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('exception');
      expect(result.error.message).toBe('boom');
    }
  });

  it('tryCatch passes through successful return', () => {
    const result = tryCatch(() => unsafe(2));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(2);
    }
  });

  it('safe function returns domain error as value', () => {
    const result = safe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('domain');
      expect(result.error.detail).toBe('odd-mod-3');
    }
  });

  it('pipeline surfaces exception from unsafe step', () => {
    const result = pipeline(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('exception');
    }
  });

  it('pipeline surfaces domain error from safe step', () => {
    // 4 is even (unsafe passes), but 4%3===1 (safe fails)
    const result = pipeline(4);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('domain');
    }
  });

  it('pipeline returns value on happy path', () => {
    // 6 is even (unsafe passes), 6%3===0 (safe passes)
    const result = pipeline(6);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(6);
    }
  });

  it('key discriminates between error types', () => {
    const thrown = pipeline(1);
    const domain = pipeline(4);

    if (!thrown.ok && thrown.error.key === 'exception') {
      expectTypeOf(thrown.error).toExtend<OctExceptionError>();
      expect(thrown.error.cause).toBeInstanceOf(Error);
    }

    if (!domain.ok && domain.error.key === 'domain') {
      expectTypeOf(domain.error).toExtend<DomainError>();
      expect(domain.error.detail).toBe('odd-mod-3');
    }
  });
});