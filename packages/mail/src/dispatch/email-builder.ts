import type { Result } from '@octabits-io/foundation/result';
import { ok, err } from '@octabits-io/foundation/result';
import type { MailError } from '../base/errors';
import type {
  BaseMailParams,
  MailClassification,
  MailDeliveryMode,
  MailTemplateBuilder,
  MailTemplateRegistry,
  SystemMailParams,
  UserMailParams,
} from './types';

// ============================================================================
// Recipient resolution
// ============================================================================

/**
 * - `recipients`: addresses the message is actually delivered to.
 * - `primaryRecipient`: the originally intended recipient (for logging/tracking).
 * - `degradedToDefault`: set when `customer_and_notifications` was requested but
 *   no notifications address is configured, so the BCC was skipped and only the
 *   user received the mail.
 */
export interface RecipientsResult {
  recipients: string[];
  primaryRecipient: string;
  degradedToDefault?: boolean;
}

/**
 * Resolve delivery recipients from params, classification and delivery mode.
 *
 * Scoped mail never falls back to a platform-level address. When the scope has
 * no `notificationsAddress`:
 * - system (operator) mail → `mail_not_configured` (refuse to send)
 * - `notifications_only` mode → `mail_not_configured` (refuse to send)
 * - `customer_and_notifications` mode → degrade to default (user only) + caller logs
 * - `default` mode → unaffected
 */
export function resolveRecipients(
  params: BaseMailParams,
  classification: MailClassification,
  notificationsAddress: string | undefined,
  deliveryMode: MailDeliveryMode = 'default',
): Result<RecipientsResult, MailError> {
  // Operator (system) mail: routed to the notifications inbox.
  if (classification === 'system') {
    const p = params as SystemMailParams;
    // Test flow: bypass routing and send to the override recipient.
    if (p.bypassDeliveryMode && p.bypassRecipient) {
      return ok({ recipients: [p.bypassRecipient], primaryRecipient: p.bypassRecipient });
    }
    if (!notificationsAddress) {
      return err({
        key: 'mail_not_configured',
        message: `Cannot send operator notification (${params.type}): scope has no notifications address configured.`,
      });
    }
    return ok({ recipients: [notificationsAddress], primaryRecipient: notificationsAddress });
  }

  // User mail: apply delivery mode with no platform fallback.
  const p = params as UserMailParams;
  const userEmail = p.email;

  switch (deliveryMode) {
    case 'notifications_only':
      if (!notificationsAddress) {
        return err({
          key: 'mail_not_configured',
          message: `Cannot send ${params.type}: delivery mode is notifications_only but scope has no notifications address configured.`,
        });
      }
      return ok({ recipients: [notificationsAddress], primaryRecipient: userEmail });
    case 'customer_and_notifications':
      if (!notificationsAddress) {
        // Degrade to default — user still gets their mail; BCC is skipped.
        return ok({ recipients: [userEmail], primaryRecipient: userEmail, degradedToDefault: true });
      }
      return ok({ recipients: [userEmail, notificationsAddress], primaryRecipient: userEmail });
    case 'default':
    default:
      return ok({ recipients: [userEmail], primaryRecipient: userEmail });
  }
}

// ============================================================================
// Subject redirect prefix
// ============================================================================

/**
 * Prefix the subject when the mail was redirected (primary recipient not in the
 * actual recipients), so it's clear who the original recipient was.
 */
export function applyRedirectSubjectPrefix(
  subject: string,
  recipientsResult: RecipientsResult,
): string {
  const wasRedirected = !recipientsResult.recipients.includes(recipientsResult.primaryRecipient);
  if (!wasRedirected) return subject;
  return `[→ ${recipientsResult.primaryRecipient}] ${subject}`;
}

// ============================================================================
// Content building
// ============================================================================

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** Inputs the subject/content build reads from the resolved scope config. */
export interface BuildEmailContentOptions<TOverrides> {
  /** Opaque overrides passed to the template builder. */
  overrides?: TOverrides;
  /** Custom subject; wins over the template's `buildSubject`. */
  subjectOverride?: string;
  /** Brand label prefixed to the subject as `"<brand> - <subject>"`. */
  subjectBrand?: string;
}

/**
 * Build subject, HTML and text via the template builder. A `subjectOverride`
 * replaces the template subject; a `subjectBrand` is prefixed to the result
 * (guarded so an empty base subject never yields a dangling `"Brand - "`).
 */
export async function buildEmailContent<TParams, TOverrides>(
  template: MailTemplateBuilder<TParams, TOverrides>,
  params: TParams,
  options: BuildEmailContentOptions<TOverrides> = {},
): Promise<Result<EmailContent, MailError>> {
  const { overrides, subjectOverride, subjectBrand } = options;

  let baseSubject: string;
  if (subjectOverride) {
    baseSubject = subjectOverride;
  } else {
    const subjectResult = await template.buildSubject(params);
    if (!subjectResult.ok) return subjectResult;
    baseSubject = subjectResult.value;
  }

  const trimmedBase = baseSubject.trim();
  const subject = subjectBrand
    ? (trimmedBase ? `${subjectBrand} - ${trimmedBase}` : subjectBrand)
    : baseSubject;

  const htmlContentResult = await template.buildHtmlContent(params, overrides);
  if (!htmlContentResult.ok) return htmlContentResult;

  const textContentResult = await template.buildTextContent(params, overrides);
  if (!textContentResult.ok) return textContentResult;

  return ok({ subject, html: htmlContentResult.value, text: textContentResult.value });
}

// ============================================================================
// Template lookup
// ============================================================================

/** Look up the template for a `type`, or an error if none is registered. */
export function getTemplate<TOverrides>(
  templates: MailTemplateRegistry<TOverrides>,
  emailType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Result<MailTemplateBuilder<any, TOverrides>, MailError> {
  const template = templates[emailType];
  if (!template) {
    return err({
      key: 'mail_template_error',
      message: `No template registered for email type: ${emailType}`,
    });
  }
  return ok(template);
}
