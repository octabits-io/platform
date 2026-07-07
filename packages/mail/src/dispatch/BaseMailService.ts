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
import { isValidRecipientAddress, stripHeaderUnsafeChars } from './sanitize';

// ============================================================================
// onSend hook
// ============================================================================

/** How the mail was routed, passed to the `onSend` hook. */
export interface SendMailMetadata {
  /** True when sent via the platform transport because the scope has no active mail server. */
  viaPlatformFallback: boolean;
}

/**
 * Invoked after each send attempt (logging, analytics, delivery-log
 * persistence) — including refusals: when the service refuses to send
 * (missing template, `mail_not_configured`, invalid recipient, fallback
 * disabled) the hook fires with the error result and `message: undefined`
 * (no deliverable message was ever built), so refused mail still reaches the
 * delivery log.
 */
export type OnSendCallback<TParams> = (
  params: TParams,
  message: MailMessage | undefined,
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
   *
   * Lifecycle note: the service calls this on EVERY scoped-server send and
   * never closes the returned transport. Implementations should memoize by
   * config identity (e.g. host/user or a config hash) and return the cached
   * transport, so per-send calls don't leak connections/pools; the
   * implementation owns closing transports it evicts.
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

  /** Fire the onSend hook, swallowing (but logging) hook failures. */
  async function fireOnSend(
    params: TParams,
    message: MailMessage | undefined,
    result: SendMailResult,
    metadata: SendMailMetadata,
  ): Promise<void> {
    if (!onSend) return;
    try {
      await onSend(params, message, result, metadata);
    } catch (hookErr) {
      logger.error('onSend callback failed', hookErr instanceof Error ? hookErr : new Error(String(hookErr)));
    }
  }

  async function send(params: TParams): Promise<SendMailResult> {
    const preparedResult = await prepareEmail(params);
    if (!preparedResult.ok) {
      // Refusals must still reach the delivery log — fire the hook with the
      // error result (there is no message to report yet).
      if (preparedResult.error.key === 'mail_not_configured') {
        logger.warn('Mail refused: not configured', { type: params.type, reason: preparedResult.error.message });
      }
      await fireOnSend(params, undefined, preparedResult, { viaPlatformFallback: false });
      return preparedResult;
    }
    const { subject: finalSubject, html, text, recipientsResult, scopeConfig } = preparedResult.value;

    // Recipient-smuggling / header-injection guard: refuse any address a
    // transport could misread as a list (comma/semicolon), an angle-bracket
    // route, or a header break. Applied to every address that reaches a
    // provider: To, Bcc, Reply-To, and the envelope sender.
    const addressesToCheck: string[] = [
      ...recipientsResult.recipients,
      ...(recipientsResult.bcc ?? []),
      ...(params.replyTo ? [params.replyTo.address] : []),
      ...(params.returnPath ? [params.returnPath.address] : []),
    ];
    const badAddress = addressesToCheck.find((a) => !isValidRecipientAddress(a));
    if (badAddress !== undefined) {
      const refusal: SendMailResult = err({
        key: 'invalid_recipient',
        message: `Refusing to send ${params.type}: recipient address failed sanitization (separators, whitespace, control characters, or not email-shaped).`,
        address: badAddress,
      });
      logger.warn('Mail refused: invalid recipient address', { type: params.type });
      await fireOnSend(params, undefined, refusal, { viaPlatformFallback: false });
      return refusal;
    }

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
      const refusal: SendMailResult = err({
        key: 'mail_not_configured',
        message: 'Scope has no mail server configured and platform fallback is disabled',
      });
      await fireOnSend(params, undefined, refusal, { viaPlatformFallback: false });
      return refusal;
    }

    // Dev-only nuclear override: applied uniformly at the transport-selection
    // seam so EVERY route (scoped ad-hoc server, global/dev, platform fallback)
    // is redirected — otherwise scoped-server creds or a fallback path could leak
    // mail to real addresses in dev.
    if (devOverrideRecipient) {
      effectiveTransport = createDevOverrideMailTransport(effectiveTransport, devOverrideRecipient, logger);
    }

    // A caller-supplied Reply-To/Return-Path (e.g. tagged inbound addresses) wins
    // over the computed fallback. Header-bound display strings (subject, from
    // name, reply-to name — which carry scope-derived values like scopeName and
    // subjectBrand) are stripped of CR/LF so they can't inject headers.
    const effectiveReplyTo = params.replyTo ?? replyTo;
    const message: MailMessage = {
      from: { address: fromAddress, name: stripHeaderUnsafeChars(fromName) },
      to: recipientsResult.recipients,
      bcc: recipientsResult.bcc,
      replyTo: effectiveReplyTo
        ? {
            address: effectiveReplyTo.address,
            name: effectiveReplyTo.name ? stripHeaderUnsafeChars(effectiveReplyTo.name) : undefined,
          }
        : undefined,
      returnPath: params.returnPath,
      subject: stripHeaderUnsafeChars(finalSubject),
      text,
      html,
    };

    if (viaPlatformFallback) {
      logger.info('Sending mail via platform fallback transport', { type: params.type, replyTo: replyTo?.address });
    }

    const result = await effectiveTransport.send(message);
    await fireOnSend(params, message, result, { viaPlatformFallback });
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
      bcc: recipientsResult.bcc,
      primaryRecipient: recipientsResult.primaryRecipient,
    });
  }

  return { type: transport.type, send, render };
}
