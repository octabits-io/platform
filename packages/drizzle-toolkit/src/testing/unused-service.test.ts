import { describe, it, expect } from 'vitest';
import { unusedService } from './unused-service.ts';

interface SampleService {
  doThing(): Promise<void>;
  value: number;
}

describe('unusedService', () => {
  it('returns a value assignable to the requested type', () => {
    const stub = unusedService<SampleService>('sampleService');
    expect(stub).toBeDefined();
  });

  it('throws a descriptive error naming the stub and property on method access', () => {
    const stub = unusedService<SampleService>('sampleService');
    expect(() => stub.doThing()).toThrow(
      /sampleService\.doThing was called but sampleService is an unusedService stub/,
    );
  });

  it('throws on any property access, not just calls', () => {
    const stub = unusedService<SampleService>('sampleService');
    expect(() => stub.value).toThrow(/sampleService\.value was called/);
  });

  it('includes remediation guidance in the error message', () => {
    const stub = unusedService<SampleService>('mailService');
    expect(() => stub.doThing()).toThrow(/wire up a real service or a typed mock/);
  });
});
