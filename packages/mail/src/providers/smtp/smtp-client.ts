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
 * Create a nodemailer transporter from SMTP configuration
 */
export function createSmtpTransporter(config: SmtpTransportConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? false,
    requireTLS: true, // Require STARTTLS for port 587, fail if unavailable
    auth: {
      user: config.auth.user,
      pass: config.auth.pass,
    },
  });
}

/**
 * Verify SMTP connection by creating a transient transporter and calling verify().
 * Returns ok: true if connection succeeds, or an error with the failure message.
 */
export async function verifySmtpConnection(
  config: SmtpTransportConfig,
  timeoutMs = 10_000,
): Promise<Result<void, MailConfigurationError>> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? false,
    requireTLS: !(config.secure ?? false),
    auth: {
      user: config.auth.user,
      pass: config.auth.pass,
    },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
  });

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
