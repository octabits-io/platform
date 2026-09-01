/**
 * The Mailjet client helpers, below the transport. `MailjetTransport.test.ts`
 * drives sending; this covers client construction (the timeout that keeps a
 * stalled endpoint from hanging a send) and the credential check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same hoisted-mock shape as MailjetTransport.test.ts — the verify path is
// `client.get('user', { version }).request()`.
const { request, get, apiConnect } = vi.hoisted(() => {
  const request = vi.fn();
  const get = vi.fn(() => ({ request }));
  const apiConnect = vi.fn(() => ({ get }));
  return { request, get, apiConnect };
});

vi.mock('node-mailjet', () => ({ default: { apiConnect } }));

import {
  createMailjetClient,
  DEFAULT_MAILJET_TIMEOUT_MS,
  verifyMailjetConnection,
} from './mailjet-client';

const credentials = { apiKey: 'key', apiSecret: 'secret' };

beforeEach(() => vi.clearAllMocks());

describe('createMailjetClient', () => {
  it('connects with the credentials and the default timeout', () => {
    createMailjetClient(credentials);

    expect(apiConnect).toHaveBeenCalledWith('key', 'secret', {
      options: { timeout: DEFAULT_MAILJET_TIMEOUT_MS },
    });
  });

  it('honours an explicit timeout', () => {
    createMailjetClient({ ...credentials, timeoutMs: 5_000 });

    expect(apiConnect).toHaveBeenCalledWith('key', 'secret', { options: { timeout: 5_000 } });
  });
});

describe('verifyMailjetConnection', () => {
  it('makes the cheap v3 user call and reports success', async () => {
    request.mockResolvedValueOnce({ body: { Data: [] } });

    const result = await verifyMailjetConnection(credentials);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(get).toHaveBeenCalledWith('user', { version: 'v3' });
  });

  it('returns a mail_configuration_error instead of throwing on bad credentials', async () => {
    request.mockRejectedValueOnce(new Error('Unauthorized'));

    const result = await verifyMailjetConnection(credentials);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('mail_configuration_error');
    expect(result.error.message).toBe('Unauthorized');
    expect(result.error.missingConfig).toEqual([]);
  });

  it('describes a non-Error rejection rather than leaking "undefined"', async () => {
    request.mockRejectedValueOnce('socket closed');

    const result = await verifyMailjetConnection(credentials);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('Mailjet API verification failed');
  });
});
