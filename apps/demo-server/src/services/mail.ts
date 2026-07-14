/**
 * Mail dispatch — `createBaseMailService` (`…/mail`) with its four seams wired
 * to the smallest thing that actually works.
 *
 * The service renders a template, resolves per-scope config, picks recipients by
 * delivery mode, selects a transport, sends, and fires `onSend`. It never
 * imports a vendor SDK; everything vendor-shaped is injected:
 *
 *   - `templates`        → one `welcome` builder (subject/html/text).
 *   - `configReader`     → reads the `settings` table, so an operator editing
 *                          `welcomeSubject` via `PUT /api/settings` changes the
 *                          next mail's subject (`subjectOverride` wins over the
 *                          template's `buildSubject`), and `supportEmail`
 *                          becomes the Reply-To.
 *   - `transport`        → the logger transport: it prints the fully-rendered
 *                          message instead of sending it. Swapping in
 *                          `createSmtpTransport` from `…/mail/smtp` is the only
 *                          change needed to make this real.
 *   - `transportFactory` → deliberately omitted. It builds a vendor transport
 *                          from a *scope's own* mail-server config; with none
 *                          configured, routing falls to the platform transport
 *                          above, which is exactly the demo's path.
 */
import { ok } from '@octabits-io/framework/result';
import {
  createBaseMailService,
  createLoggerTransport,
} from '@octabits-io/framework/mail';
import type {
  MailTemplateRegistry,
  MailConfigReader,
  UserMailParams,
} from '@octabits-io/framework/mail';
import type { Logger } from '@octabits-io/framework/logger';
import type { SettingsService } from './settings.ts';

/** The one params shape this app sends. `email` makes it user-directed mail. */
export interface WelcomeMailParams extends UserMailParams {
  type: 'welcome';
  name: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const templates: MailTemplateRegistry = {
  welcome: {
    // Overridden by `subjectOverride` from the config reader when the
    // `welcomeSubject` setting is present — kept as the code-level default.
    buildSubject: async (_params: WelcomeMailParams) => ok('Welcome to the contact desk'),
    buildHtmlContent: async (params: WelcomeMailParams) =>
      ok(`<p>Hi ${escapeHtml(params.name)},</p><p>Thanks for joining the contact desk.</p>`),
    buildTextContent: async (params: WelcomeMailParams) =>
      ok(`Hi ${params.name},\n\nThanks for joining the contact desk.\n`),
  },
};

export interface MailServiceDeps {
  logger: Logger;
  /**
   * Resolves a settings service **per send**, not once at construction: the
   * config service caches reads for one unit of work, so a captured instance
   * would keep serving the config as it looked when this service was built.
   */
  settings: () => SettingsService;
  platformFromAddress: string;
  platformFromName: string;
}

export function createDemoMailService({
  logger,
  settings,
  platformFromAddress,
  platformFromName,
}: MailServiceDeps) {
  const configReader: MailConfigReader<WelcomeMailParams> = async () => {
    // A fresh settings instance per send — see `MailServiceDeps.settings`.
    const config = await settings().readAll();
    return {
      subjectOverride: config.welcomeSubject,
      notificationsAddress: config.supportEmail,
      scopeName: 'Contact Desk',
    };
  };

  return createBaseMailService<WelcomeMailParams>({
    platformFromAddress,
    platformFromName,
    templates,
    configReader,
    transport: createLoggerTransport({ logger }),
    logger,
    onSend: async (params, _message, result) => {
      if (result.ok) {
        logger.info('Welcome mail dispatched', { to: params.email, messageId: result.value.messageId });
      } else {
        logger.warn('Welcome mail refused', { to: params.email, key: result.error.key });
      }
    },
  });
}

export type DemoMailService = ReturnType<typeof createDemoMailService>;
