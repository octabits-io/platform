import { ok, err, toOctError, type Result, type OctError } from '../result/index.ts';
import type { Logger } from '../logger/index.ts';
import { hashCyrb53 } from '../utils/hashCyrb53.ts';

export interface ICalFetchResult {
  /** The raw iCal data with DTSTAMP lines removed. */
  data: string;
  /** Hash of the (DTSTAMP-stripped) calendar data for change detection. */
  hash: string;
  /** Whether the data changed compared to the supplied `previousHash`. */
  hasChanged: boolean;
}

/**
 * Error returned by `ICalFetcherService.fetch`. May carry an HTTP `status`
 * when the failure was a non-2xx response.
 */
export interface ICalFetchError extends OctError {
  status?: number;
}

export interface ICalFetcherService {
  /**
   * Fetch iCal data from a URL and compute its change-detection hash.
   *
   * DTSTAMP lines (including their RFC 5545 folded continuation lines) are
   * stripped before hashing — they are re-generated on every export by most
   * calendar servers and would otherwise make every fetch look like a change.
   *
   * Only `http:`/`https:` URLs are fetched (`webcal://` is rewritten to
   * `https://` first); every other scheme is rejected. URLs whose hostname is
   * a literal private, loopback, or link-local IP are rejected unless the
   * service was created with `allowPrivateNetwork: true`.
   *
   * @param url - Calendar URL. `webcal://` is rewritten to `https://`.
   * @param previousHash - Hash from a previous fetch, for change detection.
   *   Pass `null`/omit to always report `hasChanged: true`.
   * @returns `Result` with the stripped data, its hash, and the change flag.
   */
  fetch(url: string, previousHash?: string | null): Promise<Result<ICalFetchResult, ICalFetchError>>;
}

export interface CreateICalFetcherServiceParams {
  logger: Logger;
  /**
   * Injectable `fetch` implementation.
   *
   * **Security note:** the built-in private-network check only rejects URLs
   * whose hostname is a *literal* private/loopback/link-local IP. It cannot
   * see what a DNS name resolves to (DNS rebinding), and redirects are
   * followed for feed portability — so a public URL may redirect to a private
   * address. Consumers that need DNS-rebinding or redirect-to-private
   * protection must inject a `fetch` bound to a safe dispatcher (e.g. an
   * undici Agent with a filtering `lookup`/`connect`).
   *
   * @default globalThis.fetch
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Request timeout in milliseconds (covers headers *and* body streaming).
   * @default 30_000
   */
  timeoutMs?: number;
  /**
   * Maximum response size in **bytes**. Enforced against `Content-Length`
   * when present and again while streaming the body.
   * @default 5_242_880 (5 MB)
   */
  maxResponseBytes?: number;
  /**
   * Permit URLs whose hostname is a literal private/loopback/link-local IP
   * (e.g. `http://127.0.0.1/…`, `http://[::1]/…`). Off by default.
   * @default false
   */
  allowPrivateNetwork?: boolean;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000; // 30 seconds
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Strip userinfo (`user:pass@`) from a URL before embedding it in error
 * messages or log metadata — feed URLs occasionally carry credentials.
 */
function redactUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.href;
  } catch {
    // Not parsable as a URL — best-effort regex strip of `scheme://userinfo@`.
    return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  }
}

/**
 * `true` when the (URL-normalized) hostname is a literal private, loopback,
 * or link-local IP. Covers IPv4 (127/8, 10/8, 172.16/12, 192.168/16,
 * 169.254/16, 0/8) and the obvious IPv6 forms (::1, ::, fc00::/7, fe80::/10,
 * IPv4-mapped `::ffff:x.x.x.x`). The WHATWG URL parser already normalizes
 * decimal/octal/hex IPv4 spellings (e.g. `http://2130706433/` → `127.0.0.1`),
 * so matching the normalized dotted-quad is sufficient. DNS names are not
 * resolved here — see the `fetch` param's security note.
 */
function isPrivateIpHostname(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  const v6 = host.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(v6)) return true; // fe80::/10
  // IPv4-mapped: dotted form (`::ffff:192.168.0.1`) and the hex form the
  // WHATWG URL parser normalizes it to (`::ffff:c0a8:1`).
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
  if (mappedDotted?.[1]) return isPrivateIpHostname(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIpHostname(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return false;
}

/**
 * Remove DTSTAMP properties, including RFC 5545 folded continuation lines
 * (lines beginning with a space or tab belong to the preceding property).
 * Property names vary in case, so compare uppercased.
 */
function stripDtstampLines(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  let skippingFolded = false;
  for (const line of lines) {
    if (skippingFolded && (line.startsWith(' ') || line.startsWith('\t'))) {
      continue; // folded continuation of a removed DTSTAMP line
    }
    skippingFolded = false;
    if (line.toUpperCase().startsWith('DTSTAMP')) {
      skippingFolded = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

export const createICalFetcherService = ({
  logger,
  fetch: fetchImpl,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  allowPrivateNetwork = false,
}: CreateICalFetcherServiceParams): ICalFetcherService => {
  const maxResponseSizeMb = maxResponseBytes / 1024 / 1024;

  const tooLargeError = (safeUrl: string): ICalFetchError => ({
    key: 'ical_too_large',
    message: `Calendar data from ${safeUrl} exceeds maximum size of ${maxResponseSizeMb}MB`,
  });

  /**
   * Read the response body while counting BYTES cumulatively, aborting as
   * soon as the cap is exceeded — never buffer an oversized body in full.
   * Decoding to text happens incrementally (`TextDecoder` in stream mode),
   * after each chunk passes the byte check.
   */
  const readBodyCapped = async (
    response: Response,
    safeUrl: string,
  ): Promise<Result<string, ICalFetchError>> => {
    if (!response.body) {
      // No stream exposed (some fetch implementations / empty bodies):
      // fall back to text() and enforce the cap on the encoded byte length.
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
        return err(tooLargeError(safeUrl));
      }
      return ok(text);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          return err(tooLargeError(safeUrl));
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    text += decoder.decode();
    return ok(text);
  };

  const fetchICal = async (
    url: string,
    previousHash?: string | null,
  ): Promise<Result<ICalFetchResult, ICalFetchError>> => {
    // Convert webcal:// to https://
    const httpUrl = url.replace(/^webcal:\/\//i, 'https://');
    const safeUrl = redactUrl(httpUrl);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(httpUrl);
    } catch {
      return err({
        key: 'ical_url_invalid',
        message: `Invalid calendar URL: ${redactUrl(url)}`,
      });
    }

    // Scheme allowlist: only http/https survive (after the webcal rewrite).
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return err({
        key: 'ical_url_invalid',
        message: `Unsupported URL scheme "${parsedUrl.protocol.replace(/:$/, '')}" for calendar URL ${safeUrl} — only http(s) and webcal are allowed`,
      });
    }

    // Reject literal private/loopback/link-local IP hostnames (SSRF posture).
    // DNS names are NOT resolved here and redirects are followed — see the
    // `fetch` param docs for how to get full protection via an injected fetch.
    if (!allowPrivateNetwork && isPrivateIpHostname(parsedUrl.hostname)) {
      return err({
        key: 'ical_url_private_network',
        message: `Calendar URL ${safeUrl} points at a private/loopback address — pass allowPrivateNetwork: true to permit it`,
      });
    }

    const doFetch = fetchImpl ?? globalThis.fetch;

    // Plain-fetch timeout via AbortController; the signal also aborts body
    // streaming, so the timeout covers the whole download.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await doFetch(parsedUrl.href, { method: 'GET', signal: controller.signal });

      // Non-2xx: plain fetch resolves (unlike wretch, which throws), so branch here.
      if (!response.ok) {
        return err({
          key: 'ical_fetch_failed',
          message: `Failed to fetch calendar data from ${safeUrl}: ${response.statusText || `HTTP ${response.status}`}`,
          status: response.status,
        });
      }

      // Fast path: reject on the advertised Content-Length before reading.
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
        return err(tooLargeError(safeUrl));
      }

      // Stream the body with a cumulative byte cap (Content-Length may be
      // missing or wrong).
      const bodyResult = await readBodyCapped(response, safeUrl);
      if (!bodyResult.ok) {
        return bodyResult;
      }

      const data = stripDtstampLines(bodyResult.value);

      const hash = hashCyrb53(data);
      const hasChanged = previousHash === null || previousHash !== hash;

      return ok({ data, hash, hasChanged });
    } catch (ex: unknown) {
      // AbortController fires 'AbortError'; AbortSignal.timeout fires 'TimeoutError'.
      if (ex instanceof Error && (ex.name === 'AbortError' || ex.name === 'TimeoutError')) {
        return err({
          key: 'ical_fetch_timeout',
          message: `Timeout fetching calendar data from ${safeUrl} after ${timeoutMs / 1000} seconds`,
        });
      }

      logger.error('Failed to fetch iCal data', ex instanceof Error ? ex : new Error(String(ex)), {
        url: safeUrl,
      });
      return err(toOctError(ex));
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    fetch: fetchICal,
  };
};
