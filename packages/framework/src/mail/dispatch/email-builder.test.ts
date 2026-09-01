/**
 * The dispatch primitives under `./mail`, tested at their own boundary.
 *
 * `BaseMailService.test.ts` already drives every one of these through the
 * service, which is where the routing *decisions* are proven. What that view
 * cannot see is the shape each function hands back — `primaryRecipient`
 * surviving a redirect, the `degradedToDefault` flag a caller is expected to
 * log, `baseSubject` vs the branded `subject`. They are public exports of
 * `./mail`, so a consumer can compose them without the service; these tests
 * pin what such a consumer gets.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyRedirectSubjectPrefix,
  buildEmailContent,
  getTemplate,
  resolveRecipients,
  type RecipientsResult,
} from './email-builder.ts';
import type { MailTemplateBuilder, MailTemplateRegistry, SystemMailParams, UserMailParams } from './types.ts';

const user = (over: Partial<UserMailParams> = {}): UserMailParams => ({
  type: 'user-mail',
  email: 'customer@example.com',
  ...over,
});

const system = (over: Partial<SystemMailParams> = {}): SystemMailParams => ({
  type: 'system-mail',
  recipient: 'admin',
  ...over,
});

const NOTIFICATIONS = 'ops@example.com';

describe('resolveRecipients — user mail', () => {
  it('sends to the user in default mode', () => {
    const result = resolveRecipients(user(), 'user', NOTIFICATIONS, 'default');

    expect(result).toEqual({
      ok: true,
      value: { recipients: ['customer@example.com'], primaryRecipient: 'customer@example.com' },
    });
  });

  it('keeps the user as primaryRecipient when notifications_only redirects the delivery', () => {
    // The distinction the whole type exists for: `recipients` is where the
    // mail GOES, `primaryRecipient` is who it is ABOUT. Collapsing them would
    // make the redirect invisible to the subject prefix below.
    const result = resolveRecipients(user(), 'user', NOTIFICATIONS, 'notifications_only');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([NOTIFICATIONS]);
    expect(result.value.primaryRecipient).toBe('customer@example.com');
  });

  it('BCCs the notifications address in customer_and_notifications mode', () => {
    const result = resolveRecipients(user(), 'user', NOTIFICATIONS, 'customer_and_notifications');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A true BCC: the internal address must not appear in the visible To.
    expect(result.value.recipients).toEqual(['customer@example.com']);
    expect(result.value.bcc).toEqual([NOTIFICATIONS]);
  });

  it('flags the degrade when customer_and_notifications has no notifications address', () => {
    // The user still gets their mail; the BCC is silently skipped — so the
    // flag is the only trace, and the caller is expected to log it.
    const result = resolveRecipients(user(), 'user', undefined, 'customer_and_notifications');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.degradedToDefault).toBe(true);
    expect(result.value.bcc).toBeUndefined();
  });

  it('refuses notifications_only with no notifications address', () => {
    const result = resolveRecipients(user(), 'user', undefined, 'notifications_only');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('mail_not_configured');
  });

  it('refuses user mail carrying no email rather than sending to undefined', () => {
    const result = resolveRecipients(user({ email: undefined }), 'user', NOTIFICATIONS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('invalid_recipient');
  });

  it('defaults the delivery mode to default when omitted', () => {
    expect(resolveRecipients(user(), 'user', NOTIFICATIONS)).toEqual(
      resolveRecipients(user(), 'user', NOTIFICATIONS, 'default'),
    );
  });
});

describe('resolveRecipients — system mail', () => {
  it('routes to the notifications address whatever the delivery mode says', () => {
    // Operator mail has no user to address; the mode is a user-mail concept.
    for (const mode of ['default', 'notifications_only', 'customer_and_notifications'] as const) {
      expect(resolveRecipients(system(), 'system', NOTIFICATIONS, mode)).toEqual({
        ok: true,
        value: { recipients: [NOTIFICATIONS], primaryRecipient: NOTIFICATIONS },
      });
    }
  });

  it('honours a bypass recipient (the test-mail flow)', () => {
    const params = system({ bypassDeliveryMode: true, bypassRecipient: 'tester@example.com' });
    const result = resolveRecipients(params, 'system', NOTIFICATIONS);

    expect(result).toEqual({
      ok: true,
      value: { recipients: ['tester@example.com'], primaryRecipient: 'tester@example.com' },
    });
  });

  it('refuses when the scope has no notifications address', () => {
    const result = resolveRecipients(system(), 'system', undefined);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('mail_not_configured');
  });
});

describe('applyRedirectSubjectPrefix', () => {
  const redirected: RecipientsResult = {
    recipients: [NOTIFICATIONS],
    primaryRecipient: 'customer@example.com',
  };

  it('names the original recipient when the mail was redirected', () => {
    expect(applyRedirectSubjectPrefix('Booking confirmed', redirected)).toBe(
      '[→ customer@example.com] Booking confirmed',
    );
  });

  it('leaves the subject alone when the primary recipient is among the recipients', () => {
    const direct: RecipientsResult = {
      recipients: ['customer@example.com', NOTIFICATIONS],
      primaryRecipient: 'customer@example.com',
    };
    expect(applyRedirectSubjectPrefix('Booking confirmed', direct)).toBe('Booking confirmed');
  });

  it('does not prefix a BCC copy — the user is still a recipient', () => {
    const bcc: RecipientsResult = {
      recipients: ['customer@example.com'],
      bcc: [NOTIFICATIONS],
      primaryRecipient: 'customer@example.com',
    };
    expect(applyRedirectSubjectPrefix('Booking confirmed', bcc)).toBe('Booking confirmed');
  });
});

const builder = (over: Partial<MailTemplateBuilder<{ name: string }, { footer?: string }>> = {}) =>
  ({
    buildSubject: vi.fn().mockResolvedValue({ ok: true, value: 'Subject' }),
    buildHtmlContent: vi.fn().mockResolvedValue({ ok: true, value: '<p>Html</p>' }),
    buildTextContent: vi.fn().mockResolvedValue({ ok: true, value: 'Text' }),
    ...over,
  }) as MailTemplateBuilder<{ name: string }, { footer?: string }>;

describe('buildEmailContent', () => {
  it('returns the template subject and both bodies', async () => {
    const result = await buildEmailContent(builder(), { name: 'Ada' });

    expect(result).toEqual({
      ok: true,
      value: { subject: 'Subject', baseSubject: 'Subject', html: '<p>Html</p>', text: 'Text' },
    });
  });

  it('keeps baseSubject unbranded so a stored subject is not branded twice', async () => {
    // The reason `baseSubject` exists: a caller persisting the subject as a
    // thread title and re-sending under it would otherwise produce
    // "Brand - Brand - …".
    const result = await buildEmailContent(builder(), { name: 'Ada' }, { subjectBrand: 'Brand' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subject).toBe('Brand - Subject');
    expect(result.value.baseSubject).toBe('Subject');
  });

  it('brands an empty subject without leaving a dangling separator', async () => {
    const result = await buildEmailContent(
      builder({ buildSubject: vi.fn().mockResolvedValue({ ok: true, value: '   ' }) }),
      { name: 'Ada' },
      { subjectBrand: 'Brand' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subject).toBe('Brand');
  });

  it('lets subjectOverride win over the template, and never calls buildSubject', async () => {
    const template = builder();
    const result = await buildEmailContent(template, { name: 'Ada' }, { subjectOverride: 'Override' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subject).toBe('Override');
    expect(template.buildSubject).not.toHaveBeenCalled();
  });

  it('passes the opaque overrides to both body builders', async () => {
    const template = builder();
    await buildEmailContent(template, { name: 'Ada' }, { overrides: { footer: 'bye' } });

    expect(template.buildHtmlContent).toHaveBeenCalledWith({ name: 'Ada' }, { footer: 'bye' });
    expect(template.buildTextContent).toHaveBeenCalledWith({ name: 'Ada' }, { footer: 'bye' });
  });

  it('propagates a failure from any of the three build steps', async () => {
    const failure = { ok: false as const, error: { key: 'mail_template_error' as const, message: 'boom' } };

    for (const step of ['buildSubject', 'buildHtmlContent', 'buildTextContent'] as const) {
      const result = await buildEmailContent(
        builder({ [step]: vi.fn().mockResolvedValue(failure) }),
        { name: 'Ada' },
      );
      expect(result).toEqual(failure);
    }
  });
});

describe('getTemplate', () => {
  it('returns the registered builder', () => {
    const template = builder();
    const registry = { welcome: template } as unknown as MailTemplateRegistry<{ footer?: string }>;

    expect(getTemplate(registry, 'welcome')).toEqual({ ok: true, value: template });
  });

  it('names the missing type in a mail_template_error', () => {
    const registry = {} as MailTemplateRegistry<{ footer?: string }>;
    const result = getTemplate(registry, 'welcome');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('mail_template_error');
    expect(result.error.message).toContain('welcome');
  });
});
