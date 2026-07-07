// ============================================================================
// Dispatch-layer sanitization — recipient smuggling + header injection guard
// ============================================================================
//
// Transports pass MailMessage fields to their provider verbatim (nodemailer,
// for instance, treats a comma-containing `to` string as a recipient LIST), so
// a crafted address like `"victim@a.com,attacker@evil.com"` would smuggle an
// extra recipient, and CR/LF in a header-bound string would inject headers.
// The dispatch service runs every address through `isValidRecipientAddress`
// and every header-bound display string through `stripHeaderUnsafeChars`
// before building the message. See the sanitization contract on
// {@link ../base/transport#MailTransport}.

/** `,` `;` `<` `>` smuggle list entries / angle-bracket routes; whitespace and control chars break header atoms. */
// eslint-disable-next-line no-control-regex
const RECIPIENT_UNSAFE = /[,;<>\s\u0000-\u001F\u007F]/;

/** Light email shape: one `@`, non-empty local part, domain with at least one dot. */
const EMAIL_SHAPE = /^[^@]+@[^@]+\.[^@]+$/;

/**
 * True when `address` is a single, plausibly-deliverable email address that is
 * safe to hand to a transport: no list separators (`,` `;`), no angle brackets,
 * no whitespace or control characters, and a light `local@domain.tld` shape.
 * Deliberately NOT a full RFC 5321 validator — it exists to stop recipient
 * smuggling and header injection, not to referee exotic-but-valid addresses.
 */
export function isValidRecipientAddress(address: string): boolean {
  return !RECIPIENT_UNSAFE.test(address) && EMAIL_SHAPE.test(address);
}

/**
 * Strip CR/LF from a header-bound display string (subject, from name, scope
 * name, subject brand) so it cannot terminate the header and inject new ones.
 */
export function stripHeaderUnsafeChars(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}
