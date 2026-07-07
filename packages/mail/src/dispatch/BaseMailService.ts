import type { Result } from '@octabits-io/foundation/result';
import { ok, err } from '@octabits-io/foundation/result';
import type { Logger } from '@octabits-io/foundation/logger';
import type { MailMessage, MailTransport } from '../base/transport';
import type {
  SendMailResult,
  RenderMailResult,
  MailError,
} from '../base/errors';
import type {
  BaseMailParams,
  MailClassification,
  MailConfigReader,
  MailDeliveryMode,
  MailTemplateRegistry,
  ResolvedMailConfig,
  ScopedMailServerConfig,
} from './types';
import {
  buildEmailContent,
  applyRedirectSubjectPrefix,
  getTemplate,
  resolveRecipients,
  type RecipientsResult,
} from './email-builder';
import { createDevOverrideMailTransport } from './devOverride';

// ============================================================================
// onSend hook
// ============================================================================

/** How the mail was routed, passed to the `onSend` hook. */
export interface SendMailMetadata {
  /** True when sent via the platform transport because the scope has no active mail server. */
  viaPlatformFallback: boolean;
}

/** Invoked after each send attempt (logging, analytics, delivery-log persistence). */
export type OnSendCallback<TParams> = (
  params: TParams,
  message: MailMessage,
  result: SendMailResult,
  metadata: SendMailMetadata,
) => Promise<void>;

// ============================================================================
// Service config + interface
// ============================================================================

export interface BaseMailServiceConfig<
  TParams extends BaseMailParams,
  TOverrides = unknown,
  TServerConfig extends ScopedMailServerConfig = ScopedMailServerConfig,
> {
  /** From address for the platform transport (dev/test + platform fallback). */
  platformFromAddress: string;
  /** From display name for the platform transport. */
  platformFromName?: string;
  /**
   * Brand used in the platform-fallback From display name (`"<scopeName> via
   * <brand>"`). Defaults to `platformFromName`.
   */
  platformBrandName?: string;
  /** Template builders keyed by `params.type`. */
  templates: MailTemplateRegistry<TOverrides>;
  /**
   * Resolves the scoped config for a send (locale, overrides, delivery mode,
   * mail server, …). Omit for dev/test: the service uses the global `transport`
   * with the platform identity.
   */
  configReader?: MailConfigReader<TParams, TOverrides, TServerConfig>;
  /**
   * Classifies a params object as user- or system-directed. Defaults to a
   * structural check: `recipient === 'admin'` → `system`, otherwise `user`.
   */
  classify?: (params: TParams) => MailClassification;
  /**
   * Builds a transport from a scope's mail-server config. Required for the
   * scoped-server path — when omitted, a resolved `mailServerConfig` is ignored
   * and routing falls through to the platform fallback. Vendor wiring lives here,
   * keeping this module vendor-free.
   */
  transportFactory?: (config: TServerConfig) => MailTransport;
  /** Global transport (platform identity / dev / test). */
  transport: MailTransport;
  logger: Logger;
  /** Invoked after each send (fire-and-forget; errors are logged, not propagated). */
  onSend?: OnSendCallback<TParams>;
  /** Force `notifications_only` for all user mail (test mail with `bypassDeliveryMode` exempt). */
  forceNotificationsOnlyDelivery?: boolean;
  /** Dev-only nuclear override: redirect every outgoing mail to this address, including scoped-server mail. */
  devOverrideRecipient?: string;
}

export interface BaseMailService<TParams extends BaseMailParams> {
  readonly type: string;
  send(params: TParams): Promise<SendMailResult>;
  /** Render (subject/html/text/recipients) without sending — for previews. */
  render(params: TParams): Promise<RenderMailResult>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Generic transactional mail-dispatch service. Renders a template, resolves the
 * scoped config, picks recipients per delivery mode, selects a transport
 * (scoped mail server vs platform fallback), applies dev-override + redirect
 * subject prefixing, sends, and fires the `onSend` hook.
 *
 * All couplings are injected seams:
 * - `templates` + `classify` — template lookup and user/system routing.
 * - `configReader` — scope config (locale, overrides, delivery, mail server).
 * - `transportFactory` — builds a vendor transport from a scoped mail-server
 *   config (keeps this module vendor-free).
 *
 * @example
 * ```ts
 * const service = createBaseMailService({
 *   platformFromAddress: 'noreply@example.com',
 *   platformFromName: 'Example',
 *   templates,
 *   configReader,
 *   transportFactory,
 *   transport: createMemoryTransport(),
 *   logger,
 * });
 * await service.send({ type: 'welcome', email: 'user@example.com' });
 * ```
 */
export function createBaseMailService<
  TParams extends BaseMailParams,
  TOverrides = unknown,
  TServerConfig extends ScopedMailServerConfig = ScopedMailServerConfig,
>(config: BaseMailServiceConfig<TParams, TOverrides, TServerConfig>): BaseMailService<TParams> {
  const {
    platformFromAddress,
    platformFromName,
    platformBrandName,
    templates,
    configReader,
    transportFactory,
    transport,
    logger,
    onSend,
    forceNotificationsOnlyDelivery,
    devOverrideRecipient,
  } = config;

  const classify = config.classify
    ?? ((params: TParams): MailClassification =>
      'recipient' in params && (params as { recipient?: unknown }).recipient === 'admin'
        ? 'system'
        : 'user');

  const viaBrand = platformBrandName ?? platformFromName;

  if (forceNotificationsOnlyDelivery) {
    logger.warn('Mail forceNotificationsOnlyDelivery active: all user mail forced to notifications_only');
  }

  interface PreparedEmail {
    subject: string;
    html: string;
    text: string;
    recipientsResult: RecipientsResult;
    scopeConfig: ResolvedMailConfig<TOverrides, TServerConfig> | undefined;
  }

  async function prepareEmail(params: TParams): Promise<Result<PreparedEmail, MailError>> {
    const templateResult = getTemplate(templates, params.type);
    if (!templateResult.ok) return templateResult;

    const scopeConfig = configReader ? await configReader(params) : undefined;
    const classification = classify(params);

    const paramsWithLocale = scopeConfig?.locale && !params.locale
      ? { ...params, locale: scopeConfig.locale }
      : params;

    const contentResult = await buildEmailContent(templateResult.value, paramsWithLocale, {
      overrides: scopeConfig?.overrides,
      subjectOverride: scopeConfig?.subjectOverride,
      subjectBrand: scopeConfig?.subjectBrand,
    });
    if (!contentResult.ok) return contentResult;

    // Effective delivery mode:
    // - forceNotificationsOnlyDelivery (env): force notifications_only for user mail
    // - sendToSystemAddress: force notifications_only (manual test with real data)
    // - bypassDeliveryMode: force default (test mail with mock data)
    const isBypassingDeliveryMode = 'bypassDeliveryMode' in params
      && Boolean((params as { bypassDeliveryMode?: unknown }).bypassDeliveryMode);
    const effectiveDeliveryMode: MailDeliveryMode = (() => {
      if (forceNotificationsOnlyDelivery && classification === 'user' && !isBypassingDeliveryMode) {
        return 'notifications_only';
      }
      if ('sendToSystemAddress' in params && Boolean((params as { sendToSystemAddress?: unknown }).sendToSystemAddress)) {
        return 'notifications_only';
      }
      if (isBypassingDeliveryMode) return 'default';
      return scopeConfig?.deliveryMode ?? 'default';
    })();

    const recipientsResult = resolveRecipients(
      params,
      classification,
      scopeConfig?.notificationsAddress,
      effectiveDeliveryMode,
    );
    if (!recipientsResult.ok) return recipientsResult;

    const finalSubject = applyRedirectSubjectPrefix(contentResult.value.subject, recipientsResult.value);

    return ok({
      subject: finalSubject,
      html: contentResult.value.html,
      text: contentResult.value.text,
      recipientsResult: recipientsResult.value,
      scopeConfig,
    });
  }

  async function send(params: TParams): Promise<SendMailResult> {
    const preparedResult = await prepareEmail(params);
    if (!preparedResult.ok) return preparedResult;
    const { subject: finalSubject, html, text, recipientsResult, scopeConfig } = preparedResult.value;

    if (recipientsResult.degradedToDefault) {
      logger.warn(
        'Delivery mode customer_and_notifications degraded to default: scope has no notifications address. BCC skipped; user still received the mail.',
        { type: params.type },
      );
    }

    // Transport + From + Reply-To resolution. Three paths:
    //   1. Scope has an active mail server (+ transportFactory) → scoped transport,
    //      From = the scoped server's from address.
    //   2. No active scoped server + platform fallback enabled → platform transport,
    //      From = "<scopeName> via <brand>", Reply-To = notifications inbox (never
    //      the platform; omitted entirely when the scope has no notifications inbox).
    //   3. No active scoped server + platform fallback disabled → mail_not_configured.
    // When there is no scope config at all (dev/test) the global transport is used
    // directly with the platform identity.
    const scopedServer = scopeConfig?.mailServerConfig ?? undefined;
    const scopedServerActive = !!scopedServer
      && scopeConfig?.mailServerEnabled !== false
      && !!transportFactory;

    let effectiveTransport: MailTransport;
    let fromAddress: string;
    let fromName: string;
    let replyTo: { address: string; name?: string } | undefined;
    let viaPlatformFallback = false;

    if (scopedServerActive && scopedServer && transportFactory) {
      effectiveTransport = transportFactory(scopedServer);
      fromAddress = scopedServer.fromAddress;
      fromName = scopedServer.fromName || fromAddress;
    } else if (scopeConfig === undefined) {
      // No scope context (dev/test) — global transport with platform identity.
      effectiveTransport = transport;
      fromAddress = platformFromAddress;
      fromName = platformFromName || fromAddress;
    } else if (scopeConfig.platformFallbackEnabled !== false) {
      // Scope context but no active mail server: fall back to the platform transport.
      effectiveTransport = transport;
      viaPlatformFallback = true;
      fromAddress = platformFromAddress;
      const scopeName = scopeConfig.scopeName;
      fromName = scopeName && viaBrand
        ? `${scopeName} via ${viaBrand}`
        : (scopeName ?? platformFromName ?? fromAddress);
      // Reply-To never leaks to the platform: use the scope's notifications inbox,
      // omit the header entirely when it is not configured.
      replyTo = scopeConfig.notificationsAddress
        ? { address: scopeConfig.notificationsAddress, name: scopeConfig.scopeName }
        : undefined;
    } else {
      logger.warn('Scope has no active mail server and platform fallback is disabled — skipping delivery', { type: params.type });
      return err({ key: 'mail_not_configured', message: 'Scope has no mail server configured and platform fallback is disabled' });
    }

    // Dev-only nuclear override: applied uniformly at the transport-selection
    // seam so EVERY route (scoped ad-hoc server, global/dev, platform fallback)
    // is redirected — otherwise scoped-server creds or a fallback path could leak
    // mail to real addresses in dev.
    if (devOverrideRecipient) {
      effectiveTransport = createDevOverrideMailTransport(effectiveTransport, devOverrideRecipient, logger);
    }

    // A caller-supplied Reply-To/Return-Path (e.g. tagged inbound addresses) wins
    // over the computed fallback.
    const message: MailMessage = {
      from: { address: fromAddress, name: fromName },
      to: recipientsResult.recipients,
      replyTo: params.replyTo ?? replyTo,
      returnPath: params.returnPath,
      subject: finalSubject,
      text,
      html,
    };

    if (viaPlatformFallback) {
      logger.info('Sending mail via platform fallback transport', { type: params.type, replyTo: replyTo?.address });
    }

    const result = await effectiveTransport.send(message);

    if (onSend) {
      try {
        await onSend(params, message, result, { viaPlatformFallback });
      } catch (hookErr) {
        logger.error('onSend callback failed', hookErr instanceof Error ? hookErr : new Error(String(hookErr)));
      }
    }

    return result;
  }

  async function render(params: TParams): Promise<RenderMailResult> {
    const preparedResult = await prepareEmail(params);
    if (!preparedResult.ok) return preparedResult;
    const { subject, html, text, recipientsResult } = preparedResult.value;
    return ok({
      subject,
      html,
      text,
      recipients: recipientsResult.recipients,
      primaryRecipient: recipientsResult.primaryRecipient,
    });
  }

  return { type: transport.type, send, render };
}
