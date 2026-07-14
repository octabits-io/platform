import wretch from 'wretch';
import type { Result } from '../../../result/index.ts';
import type { MailConfigurationError } from '../../base/errors';

// ============================================================================
// Brevo HTTP client
// ============================================================================
//
// Thin wrapper over Brevo's Transactional Email REST API built on `wretch`,
// authenticated with the `api-key` header. We only need two endpoints: send a
// transactional email, and a cheap authenticated GET for the connection test.

const BREVO_API_BASE = 'https://api.brevo.com/v3';

/** Default per-request HTTP timeout for Brevo API calls. */
export const DEFAULT_BREVO_TIMEOUT_MS = 30_000;

export interface BrevoCredentials {
  apiKey: string;
  /** Per-request HTTP timeout in milliseconds. Defaults to 30s. */
  timeoutMs?: number;
}

export interface BrevoSendEmailPayload {
  sender: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  replyTo?: { email: string; name?: string };
  subject: string;
  textContent: string;
  htmlContent: string;
  /** Base64-encoded attachments. */
  attachment?: Array<{ name: string; content: string }>;
}

export interface BrevoSendEmailResponse {
  /** Provider Message-ID (RFC 5322), e.g. `<...@smtp-relay.mailin.fr>`. */
  messageId: string | null;
}

export interface BrevoClient {
  /**
   * POST /smtp/email — sends a transactional email and returns the provider
   * Message-ID so callers can persist it for delivery/bounce event correlation.
   * Throws a wretch HTTP error (status + parsed body) on a non-2xx response.
   */
  sendTransacEmail(payload: BrevoSendEmailPayload): Promise<BrevoSendEmailResponse>;
}

/**
 * Subset of wretch's rejection shape we read on the error path. wretch does not
 * re-export its `WretchError` interface from the package root, so we model the
 * fields we use. On a non-2xx response wretch rejects with an `Error` carrying
 * `status`, the parsed `json` body (when JSON), raw `text`, and `response`.
 */
interface WretchHttpError extends Error {
  status: number;
  text?: string;
  json?: unknown;
}

/**
 * Base wretch instance for the Brevo API, authenticated with the api-key
 * header. A fresh `AbortSignal.timeout` per call bounds every request so a
 * stalled Brevo endpoint can't hang a send indefinitely.
 */
function brevoApi(credentials: BrevoCredentials) {
  return wretch(BREVO_API_BASE)
    .headers({
      'api-key': credentials.apiKey,
      accept: 'application/json',
    })
    .options({ signal: AbortSignal.timeout(credentials.timeoutMs ?? DEFAULT_BREVO_TIMEOUT_MS) });
}

/**
 * Create a Brevo client from credentials.
 */
export function createBrevoClient(credentials: BrevoCredentials): BrevoClient {
  async function sendTransacEmail(
    payload: BrevoSendEmailPayload,
  ): Promise<BrevoSendEmailResponse> {
    const data = await brevoApi(credentials)
      .url('/smtp/email')
      .post(payload)
      .json<{ messageId?: string }>();

    return { messageId: data.messageId ?? null };
  }

  return { sendTransacEmail };
}

/**
 * Verify Brevo connection by making a cheap authenticated API call.
 */
export async function verifyBrevoConnection(
  credentials: BrevoCredentials,
): Promise<Result<void, MailConfigurationError>> {
  try {
    await brevoApi(credentials).url('/account').get().res();
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: {
        key: 'mail_configuration_error',
        message: `Brevo API verification failed: ${formatBrevoError(err)}`,
        missingConfig: [],
      },
    };
  }
}

/** Duck-typed check for a wretch HTTP error (a rejected non-2xx response). */
function isWretchHttpError(err: unknown): err is WretchHttpError {
  return (
    err instanceof Error &&
    typeof (err as Partial<WretchHttpError>).status === 'number' &&
    'response' in err
  );
}

/**
 * Extracts a one-line, human-readable description from whatever the Brevo client
 * threw. Handles wretch HTTP errors (status + JSON `{ code, message }` body or
 * raw text), plain Error, and unknown values. Falls back to a string so
 * something useful always reaches the audit log.
 */
export function formatBrevoError(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;

  if (isWretchHttpError(err)) {
    // wretch surfaces the response body inconsistently: `json` (parsed) /
    // `text` (raw) on some paths, but wretch v3 lands the raw body string in
    // `message`. Prefer the parsed body, then fall back to parsing whichever
    // raw string is present.
    const rawBody = err.text ?? (typeof err.message === 'string' ? err.message : undefined);
    let body = err.json as { code?: string; message?: string } | undefined;
    if (!body && rawBody) {
      try {
        body = JSON.parse(rawBody) as { code?: string; message?: string };
      } catch {
        // Body wasn't JSON — keep the raw string as the message below.
      }
    }
    const apiMessage = body
      ? [body.code, body.message].filter(Boolean).join(' / ') || undefined
      : rawBody || undefined;
    return [`${err.status}`, apiMessage].filter(Boolean).join(' — ');
  }

  if (err instanceof Error) return err.message;

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
