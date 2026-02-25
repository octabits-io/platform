import type { Result } from '../result/index.ts';

export function tryDecodeBase64(str: string): Result<string> {
  // Check if the string matches the base64 pattern
  const base64Regex = /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/;

  // Check if the string length is a multiple of 4
  if (str.length % 4 !== 0) {
    return {
      ok: false,
      error: null!,
    };
  }

  // Check if the string matches the regex
  if (!base64Regex.test(str)) {
    return {
      ok: false,
      error: null!,
    };
  }

  // Try decoding the string to ensure it's valid base64
  try {
    const retVal = atob(str);
    return {
      ok: true,
      value: retVal,
    };
  } catch (e) {
    return {
      ok: false,
      error: null!,
    };
  }
}
