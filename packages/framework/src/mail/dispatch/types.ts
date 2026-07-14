import type { Result } from '../../result/index.ts';
import type { MailTemplateError } from '../base/errors';

// ============================================================================
// Mail params — structural bases
// ============================================================================
//
// The dispatch service is generic over the caller's send-params union. The union
// members must structurally extend one of the bases below so the pipeline can
// resolve recipients and thread locale / reply routing without knowing the
// caller's concrete message types.

/** Fields every send-params object carries. */
export interface BaseMailParams {
  /** Discriminator selecting the template in the registry. */
  type: string;
  /** Opaque locale tag; threaded into the params passed to the template builder. */
  locale?: string;
  /**
   * Caller-supplied Reply-To override. Wins over any reply-to the service
   * computes (e.g. the platform-fallback notifications inbox) — e.g. a tagged
   * `reply+…` inbound address. Omit to keep the computed fallback.
   */
  replyTo?: { address: string; name?: string };
  /**
   * Caller-supplied envelope sender (SMTP MAIL FROM / Return-Path), e.g. a
   * tagged `bounce+…` inbound address. SMTP-only; ignored by transports without
   * a per-message envelope sender.
   */
  returnPath?: { address: string };
}

/** Params for mail directed at an end recipient (`email`); subject to delivery mode. */
export interface UserMailParams extends BaseMailParams {
  /** Intended recipient address. */
  email: string;
  /** Skip delivery-mode routing and send directly to the intended recipient (test mail). */
  bypassDeliveryMode?: boolean;
  /** Force-route to the notifications address only (manual test with real data). */
  sendToSystemAddress?: boolean;
}

/** Params for mail directed at the scope's operators (the notifications inbox). */
export interface SystemMailParams extends BaseMailParams {
  recipient: 'admin';
  /** Skip delivery routing and send to `bypassRecipient` instead of the notifications address. */
  bypassDeliveryMode?: boolean;
  /** Recipient used when `bypassDeliveryMode` is set. */
  bypassRecipient?: string;
}

/** How a params object is routed: to an end user, or to the scope's operators. */
export type MailClassification = 'user' | 'system';

// ============================================================================
// Template builder + registry
// ============================================================================

/**
 * Builds the three parts of an email for a given params type. `TOverrides` is an
 * opaque per-render overrides object the dispatch service passes straight through
 * — the service never inspects it.
 */
export interface MailTemplateBuilder<TParams, TOverrides = unknown> {
  buildSubject(params: TParams): Promise<Result<string, MailTemplateError>>;
  buildHtmlContent(params: TParams, overrides?: TOverrides): Promise<Result<string, MailTemplateError>>;
  buildTextContent(params: TParams, overrides?: TOverrides): Promise<Result<string, MailTemplateError>>;
}

/**
 * Maps each `type` discriminator to its template builder. The param type is `any`
 * at storage so a caller's strongly-typed per-type builders remain assignable;
 * the service casts on lookup and passes the matching params through.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MailTemplateRegistry<TOverrides = unknown> = Record<string, MailTemplateBuilder<any, TOverrides>>;

// ============================================================================
// Config reader seam
// ============================================================================

/** Delivery routing for user mail. Mirrors the classic customer / notifications split. */
export type MailDeliveryMode = 'default' | 'notifications_only' | 'customer_and_notifications';

/**
 * Minimal shape the service needs from a scoped mail-server config: the visible
 * From identity. Vendor-specific fields (host, api key, …) ride along on the
 * concrete `TServerConfig` and are handed verbatim to the transport factory.
 */
export interface ScopedMailServerConfig {
  fromAddress: string;
  fromName?: string;
}

/**
 * Per-send resolved config for a scope, produced by the injected
 * {@link MailConfigReader}. Everything is optional — an undefined result means
 * "no scope context" (dev/test), and the service uses its global transport with
 * the platform identity.
 */
export interface ResolvedMailConfig<
  TOverrides = unknown,
  TServerConfig extends ScopedMailServerConfig = ScopedMailServerConfig,
> {
  /** Locale applied to params when the caller didn't set one. */
  locale?: string;
  /** Opaque overrides passed straight to the template builder. */
  overrides?: TOverrides;
  /** Custom subject line; wins over the template's `buildSubject`. */
  subjectOverride?: string;
  /** Brand label prefixed to the subject as `"<brand> - <subject>"` when set. */
  subjectBrand?: string;
  /** Notifications inbox: receives operator mail + delivery-mode redirects. Never a platform address. */
  notificationsAddress?: string;
  /** Scope display name — used for the platform-fallback From (`"<scopeName> via <brand>"`) and fallback Reply-To name. */
  scopeName?: string;
  /** Delivery routing for user mail. Defaults to `default`. */
  deliveryMode?: MailDeliveryMode;
  /** Scope's own mail-server config. When active, mail is sent via `transportFactory(config)`. */
  mailServerConfig?: TServerConfig | null;
  /** Operator kill-switch: when `false`, `mailServerConfig` is bypassed even if present. Defaults `true`. */
  mailServerEnabled?: boolean;
  /** When the scope has no active mail server, fall back to the platform transport. Defaults `true`. */
  platformFallbackEnabled?: boolean;
}

/**
 * Resolves the scoped config for a send. Return `undefined` to signal "no scope
 * context" (the service then uses its global transport + platform identity).
 */
export type MailConfigReader<
  TParams,
  TOverrides = unknown,
  TServerConfig extends ScopedMailServerConfig = ScopedMailServerConfig,
> = (params: TParams) => Promise<ResolvedMailConfig<TOverrides, TServerConfig> | undefined>;
