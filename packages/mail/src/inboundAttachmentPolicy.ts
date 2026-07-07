/**
 * Inbound attachment security policy.
 *
 * Inbound email is an untrusted, internet-facing ingress: anyone who learns a
 * scope's reply address can mail it arbitrary files. Upstream providers do their
 * own spam scoring but make no guarantee about attachment safety, so screen every
 * inbound attachment here before its bytes are ever fetched or stored.
 *
 * This module is intentionally a pure, dependency-free policy so the rules live
 * in one place and can be unit-tested in isolation. It does NOT scan for malware
 * (no AV integration); it enforces cheap, deterministic guardrails: a size
 * ceiling, a per-message count cap, and an executable / dangerous-type blocklist.
 *
 * The default limits and blocklists are exported as constants and can be
 * overridden per call via {@link screenInboundAttachment}'s optional policy
 * argument (see {@link InboundAttachmentPolicy}); the defaults are collected in
 * {@link DEFAULT_INBOUND_ATTACHMENT_POLICY}.
 */

/** Hard ceiling on a single inbound attachment's stored bytes (25 MiB). */
export const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Max attachments persisted per inbound message. Extras are dropped + logged. */
export const MAX_INBOUND_ATTACHMENTS_PER_MESSAGE = 20;

/**
 * File extensions we refuse to store. Direct-execution binaries, OS scripts, and
 * macro-enabled Office documents — the classic email malware carriers. Archives
 * (zip/rar/7z) are deliberately NOT blocked (legitimate use); catching payloads
 * hidden inside them is a malware-scanning concern, not a blocklist one.
 */
export const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows executables / installers / libraries
  'exe', 'com', 'scr', 'pif', 'bat', 'cmd', 'msi', 'msp', 'dll', 'sys', 'cpl',
  'msc', 'gadget', 'application',
  // Scripts (Windows / cross-platform)
  'vbs', 'vbe', 'js', 'jse', 'ws', 'wsf', 'wsc', 'wsh', 'ps1', 'ps1xml', 'ps2',
  'psc1', 'psc2', 'hta', 'reg', 'scf', 'inf', 'lnk',
  // Java / Android / *nix executables + packages
  'jar', 'apk', 'sh', 'bash', 'csh', 'ksh', 'run', 'bin', 'deb', 'rpm',
  // macOS executables
  'app', 'command', 'pkg',
  // Macro-enabled Office documents
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'sldm',
]);

/**
 * MIME types we refuse to store. Secondary signal to the extension blocklist —
 * a sender can mislabel either one, so we reject on EITHER match.
 */
export const BLOCKED_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-sharedlib',
  'application/x-object',
  'application/vnd.microsoft.portable-executable',
  'application/x-ms-shortcut',
  'application/x-msi',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-bat',
  'application/x-csh',
  'application/x-perl',
  'application/x-python',
  'application/java-archive',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
]);

/**
 * Tunable inbound-attachment policy. Every field is optional; omitted fields
 * fall back to the module defaults ({@link DEFAULT_INBOUND_ATTACHMENT_POLICY}).
 */
export interface InboundAttachmentPolicy {
  /** Hard ceiling on a single attachment's bytes. */
  maxBytes?: number;
  /** Max attachments persisted per message (enforced by the caller). */
  maxPerMessage?: number;
  /** Lower-cased file extensions to refuse. */
  blockedExtensions?: ReadonlySet<string>;
  /** Lower-cased MIME types to refuse. */
  blockedMimeTypes?: ReadonlySet<string>;
}

/** The default policy — the exported constants collected into one object. */
export const DEFAULT_INBOUND_ATTACHMENT_POLICY: Required<InboundAttachmentPolicy> = {
  maxBytes: MAX_INBOUND_ATTACHMENT_BYTES,
  maxPerMessage: MAX_INBOUND_ATTACHMENTS_PER_MESSAGE,
  blockedExtensions: BLOCKED_ATTACHMENT_EXTENSIONS,
  blockedMimeTypes: BLOCKED_ATTACHMENT_MIME_TYPES,
};

export interface InboundAttachmentDescriptor {
  /** Sender-supplied filename (untrusted). */
  name: string;
  /** Sender/provider-declared MIME type (untrusted). */
  contentType: string;
  /** Provider-declared size in bytes (untrusted — verify against real bytes too). */
  contentLength: number;
}

/** A machine-readable reason an attachment was refused, surfaced to the operator. */
export type AttachmentBlockReason =
  | 'blocked_extension'
  | 'blocked_type'
  | 'too_large';

export interface AttachmentScreenResult {
  blocked: boolean;
  /** Set when `blocked` — short, human-readable, safe to show in an inbox UI. */
  reason?: string;
  code?: AttachmentBlockReason;
}

/** Lower-cased final extension of a filename, or '' when there is none. */
export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Normalize a declared Content-Type for blocklist comparison: strip any MIME
 * parameters (`; name="x"`, `; charset=…`), trim, and lower-case. Without this
 * a parameterized header like `application/x-msdownload; name="x"` would slip
 * past the blocked-type set, which stores bare media types only.
 */
export function normalizeMimeType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Screen an inbound attachment against the policy using its DECLARED metadata.
 * Cheap, runs before any bytes are fetched. The byte size is re-checked against
 * the actual downloaded length by the caller (a declared length can lie).
 *
 * @param att   Declared attachment metadata (all fields untrusted).
 * @param policy Optional overrides; omitted fields fall back to the defaults.
 */
export function screenInboundAttachment(
  att: InboundAttachmentDescriptor,
  policy: InboundAttachmentPolicy = {},
): AttachmentScreenResult {
  const maxBytes = policy.maxBytes ?? DEFAULT_INBOUND_ATTACHMENT_POLICY.maxBytes;
  const blockedExtensions = policy.blockedExtensions ?? DEFAULT_INBOUND_ATTACHMENT_POLICY.blockedExtensions;
  const blockedMimeTypes = policy.blockedMimeTypes ?? DEFAULT_INBOUND_ATTACHMENT_POLICY.blockedMimeTypes;

  const ext = fileExtension(att.name);
  if (ext && blockedExtensions.has(ext)) {
    return { blocked: true, code: 'blocked_extension', reason: `Blocked file type ".${ext}"` };
  }

  const mime = normalizeMimeType(att.contentType);
  if (mime && blockedMimeTypes.has(mime)) {
    return { blocked: true, code: 'blocked_type', reason: `Blocked content type "${mime}"` };
  }

  if (att.contentLength > maxBytes) {
    return { blocked: true, code: 'too_large', reason: 'Attachment exceeds the size limit' };
  }

  return { blocked: false };
}
