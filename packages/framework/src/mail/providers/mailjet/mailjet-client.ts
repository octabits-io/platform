import Mailjet, { type Client } from 'node-mailjet';
import type { Result } from '../../../result/index.ts';
import type { MailConfigurationError } from '../../base/errors';

/** Default per-request HTTP timeout for Mailjet API calls. */
export const DEFAULT_MAILJET_TIMEOUT_MS = 30_000;

export interface MailjetCredentials {
  apiKey: string;
  apiSecret: string;
  /** Per-request HTTP timeout in milliseconds. Defaults to 30s. */
  timeoutMs?: number;
}

/**
 * Create a Mailjet client from credentials. Requests are bounded by a
 * per-request timeout (node-mailjet passes it through to axios) so a stalled
 * Mailjet endpoint can't hang a send indefinitely.
 */
export function createMailjetClient(credentials: MailjetCredentials): Client {
  return Mailjet.apiConnect(credentials.apiKey, credentials.apiSecret, {
    options: { timeout: credentials.timeoutMs ?? DEFAULT_MAILJET_TIMEOUT_MS },
  });
}

/**
 * Verify Mailjet connection by making a test API call.
 */
export async function verifyMailjetConnection(
  credentials: MailjetCredentials,
): Promise<Result<void, MailConfigurationError>> {
  try {
    const client = createMailjetClient(credentials);
    await client.get('user', { version: 'v3' }).request();
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: {
        key: 'mail_configuration_error',
        message: err instanceof Error ? err.message : 'Mailjet API verification failed',
        missingConfig: [],
      },
    };
  }
}
