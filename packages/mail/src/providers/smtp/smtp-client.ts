import nodemailer, { type Transporter } from 'nodemailer';
import type { Result } from '@octabits-io/foundation/result';
import type { MailConfigurationError } from '../../base/errors';

export interface SmtpTransportConfig {
  host: string;
  port: number;
  secure?: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

/**
 * The single source of truth for nodemailer transport options — used by both
 * the send transporter and the connection verifier, so `verify()` validates
 * the exact configuration real sends will use. TLS posture: implicit TLS when
 * `secure` is set; otherwise STARTTLS is REQUIRED (`requireTLS`) — the
 * connection fails rather than silently downgrading to plaintext.
 */
function buildSmtpTransportOptions(
  config: SmtpTransportConfig,
  timeouts?: { connectionTimeout: number; greetingTimeout: number },
) {
  const secure = config.secure ?? false;
  return {
    host: config.host,
    port: config.port,
    secure,
    requireTLS: !secure,
    auth: {
      user: config.auth.user,
      pass: config.auth.pass,
    },
    ...timeouts,
  };
}

/**
 * Create a nodemailer transporter from SMTP configuration
 */
export function createSmtpTransporter(config: SmtpTransportConfig): Transporter {
  return nodemailer.createTransport(buildSmtpTransportOptions(config));
}

/**
 * Verify SMTP connection by creating a transient transporter and calling verify().
 * Returns ok: true if connection succeeds, or an error with the failure message.
 * Uses the same transport options as {@link createSmtpTransporter} (plus
 * timeouts), so a passing verify reflects the real send configuration.
 */
export async function verifySmtpConnection(
  config: SmtpTransportConfig,
  timeoutMs = 10_000,
): Promise<Result<void, MailConfigurationError>> {
  const transporter = nodemailer.createTransport(
    buildSmtpTransportOptions(config, { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs }),
  );

  try {
    await transporter.verify();
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: {
        key: 'mail_configuration_error',
        message: err instanceof Error ? err.message : 'SMTP connection verification failed',
        missingConfig: [],
      },
    };
  } finally {
    transporter.close();
  }
}
