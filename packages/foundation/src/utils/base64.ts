import type { OctError } from '../result/index.ts';
import type { Result } from '../result/index.ts';
import { ok, err } from '../result/index.ts';

export interface Base64DecodeError extends OctError {
  key: 'base64_decode_error';
}

export function tryDecodeBase64(str: string): Result<string, Base64DecodeError> {
  // Check if the string matches the base64 pattern
  const base64Regex = /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/;

  // Check if the string length is a multiple of 4
  if (str.length % 4 !== 0) {
    return err({ key: 'base64_decode_error' as const, message: 'Input length is not a multiple of 4' });
  }

  // Check if the string matches the regex
  if (!base64Regex.test(str)) {
    return err({ key: 'base64_decode_error' as const, message: 'Input contains invalid base64 characters' });
  }

  // Try decoding the string to ensure it's valid base64
  try {
    const retVal = atob(str);
    return ok(retVal);
  } catch (e) {
    return err({ key: 'base64_decode_error' as const, message: 'Failed to decode base64 string' });
  }
}
