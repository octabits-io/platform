// ============================================================================
// @octabits-io/mail — provider-agnostic mail transport contract
// ============================================================================
//
// The root entry is dependency-free: the transport contract, the error
// taxonomy, and the two vendor-less transports (logger for dev, memory for
// tests). Vendor transports live behind subpath exports so consumers only
// install and load the SDKs they actually use:
//
//   @octabits-io/mail/smtp     — nodemailer   (optional peer: nodemailer)
//   @octabits-io/mail/mailjet  — node-mailjet (optional peer: node-mailjet)
//   @octabits-io/mail/brevo    — wretch       (optional peer: wretch)

// --- Base contract ---------------------------------------------------------
export type {
  MailTransport,
  MailMessage,
  MailAttachment,
} from './base/transport';
export type {
  MailConfigurationError,
  MailDeliveryError,
  MailTemplateError,
  MailNotConfiguredError,
  MailError,
  SentMailInfo,
  SendMailResult,
  RenderedEmail,
  RenderMailResult,
} from './base/errors';

// --- Logger transport (dev) ------------------------------------------------
export {
  createLoggerTransport,
} from './providers/logger/LoggerTransport';
export type {
  LoggerTransport,
  LoggerTransportDeps,
} from './providers/logger/LoggerTransport';

// --- Memory transport (test) -----------------------------------------------
export {
  createMemoryTransport,
} from './providers/memory/MemoryTransport';
export type {
  MemoryTransport,
} from './providers/memory/MemoryTransport';

// --- Inbound contract (provider-agnostic normalized shapes) ----------------
export type {
  NormalizedInboundMessage,
  NormalizedInboundAttachment,
  MailInboundParseError,
} from './base/inbound';

// --- Delivery contract (provider-agnostic delivery status + events) --------
export type {
  DeliveryStatus,
  NormalizedDeliveryEvent,
  MailEventParseError,
} from './base/delivery';

// --- Inbound attachment security policy ------------------------------------
export {
  MAX_INBOUND_ATTACHMENT_BYTES,
  MAX_INBOUND_ATTACHMENTS_PER_MESSAGE,
  BLOCKED_ATTACHMENT_EXTENSIONS,
  BLOCKED_ATTACHMENT_MIME_TYPES,
  DEFAULT_INBOUND_ATTACHMENT_POLICY,
  fileExtension,
  screenInboundAttachment,
} from './inboundAttachmentPolicy';
export type {
  InboundAttachmentPolicy,
  InboundAttachmentDescriptor,
  AttachmentBlockReason,
  AttachmentScreenResult,
} from './inboundAttachmentPolicy';

// --- Tagged reply-address formatting + parsing -----------------------------
export {
  replyAddressMessage,
  buildReplyAddress,
  buildReturnPath,
  parseReplyAddress,
} from './replyAddress';
export type {
  ReplyAddressParts,
} from './replyAddress';

// --- Transactional dispatch pipeline ---------------------------------------
export {
  createBaseMailService,
} from './dispatch/BaseMailService';
export type {
  BaseMailService,
  BaseMailServiceConfig,
  OnSendCallback,
  SendMailMetadata,
} from './dispatch/BaseMailService';
export {
  resolveRecipients,
  applyRedirectSubjectPrefix,
  buildEmailContent,
  getTemplate,
} from './dispatch/email-builder';
export type {
  RecipientsResult,
  EmailContent,
  BuildEmailContentOptions,
} from './dispatch/email-builder';
export { createDevOverrideMailTransport } from './dispatch/devOverride';
export type {
  BaseMailParams,
  UserMailParams,
  SystemMailParams,
  MailClassification,
  MailTemplateBuilder,
  MailTemplateRegistry,
  MailDeliveryMode,
  ScopedMailServerConfig,
  ResolvedMailConfig,
  MailConfigReader,
} from './dispatch/types';
