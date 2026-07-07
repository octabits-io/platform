import { ok, err, toOctError, type Result, type OctError } from '@octabits-io/foundation/result';
import type { Logger } from '@octabits-io/foundation/logger';
import { hashCyrb53 } from './hash.ts';

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
   * DTSTAMP lines are stripped before hashing — they are re-generated on every
   * export by most calendar servers and would otherwise make every fetch look
   * like a change.
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
}

const FETCH_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_RESPONSE_SIZE_MB = MAX_RESPONSE_SIZE / 1024 / 1024;

export const createICalFetcherService = ({ logger }: CreateICalFetcherServiceParams): ICalFetcherService => {
  const fetchICal = async (
    url: string,
    previousHash?: string | null,
  ): Promise<Result<ICalFetchResult, ICalFetchError>> => {
    // Convert webcal:// to https://
    const httpsUrl = url.replace(/^webcal:\/\//, 'https://');

    // Plain-fetch timeout via AbortController (the `vault` package precedent).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(httpsUrl, { method: 'GET', signal: controller.signal });

      // Non-2xx: plain fetch resolves (unlike wretch, which throws), so branch here.
      if (!response.ok) {
        return err({
          key: 'ical_fetch_failed',
          message: `Failed to fetch calendar data from ${url}: ${response.statusText || `HTTP ${response.status}`}`,
          status: response.status,
        });
      }

      // Check the advertised Content-Length before reading the body.
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        return err({
          key: 'ical_too_large',
          message: `Calendar data from ${url} exceeds maximum size of ${MAX_RESPONSE_SIZE_MB}MB`,
        });
      }

      const rawData = await response.text();

      // Re-check the actual size (Content-Length may be missing or wrong).
      if (rawData.length > MAX_RESPONSE_SIZE) {
        return err({
          key: 'ical_too_large',
          message: `Calendar data from ${url} exceeds maximum size of ${MAX_RESPONSE_SIZE_MB}MB`,
        });
      }

      // Remove DTSTAMP lines to avoid detecting changes on every fetch. DTSTAMP
      // is a timestamp that changes on every export but does not affect the
      // actual events. Property names can vary in case, so compare uppercased.
      const data = rawData
        .split('\n')
        .filter((line) => !line.toUpperCase().startsWith('DTSTAMP'))
        .join('\n');

      const hash = hashCyrb53(data);
      const hasChanged = previousHash === null || previousHash !== hash;

      return ok({ data, hash, hasChanged });
    } catch (ex: unknown) {
      // AbortController fires 'AbortError'; AbortSignal.timeout fires 'TimeoutError'.
      if (ex instanceof Error && (ex.name === 'AbortError' || ex.name === 'TimeoutError')) {
        return err({
          key: 'ical_fetch_timeout',
          message: `Timeout fetching calendar data from ${url} after ${FETCH_TIMEOUT_MS / 1000} seconds`,
        });
      }

      logger.error('Failed to fetch iCal data', ex instanceof Error ? ex : new Error(String(ex)), { url });
      return err(toOctError(ex));
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    fetch: fetchICal,
  };
};
