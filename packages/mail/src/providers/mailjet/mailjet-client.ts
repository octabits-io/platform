import Mailjet, { type Client } from 'node-mailjet';
import type { Result } from '@octabits-io/foundation/result';
import type { MailConfigurationError } from '../../base/errors';

export interface MailjetCredentials {
  apiKey: string;
  apiSecret: string;
}

/**
 * Create a Mailjet client from credentials
 */
export function createMailjetClient(credentials: MailjetCredentials): Client {
  return Mailjet.apiConnect(credentials.apiKey, credentials.apiSecret);
}

/**
 * Verify Mailjet connection by making a test API call.
 */
export async function verifyMailjetConnection(
  credentials: MailjetCredentials,
): Promise<Result<void, MailConfigurationError>> {
  try {
    const client = Mailjet.apiConnect(credentials.apiKey, credentials.apiSecret);
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
