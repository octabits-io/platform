/**
 * Tagged reply-address formatting + parsing — PURE, NO CRYPTO.
 *
 * An inbound-email routing scheme can encode a `(scopeKey, resourceId)` pair
 * plus a short verification tag into the local part of a controlled address:
 *
 *   reply+<scopeKey>.<resourceId>.<tag>@<inbound-domain>
 *   bounce+<scopeKey>.<resourceId>.<tag>@<inbound-domain>   (Return-Path)
 *
 * - `scopeKey` selects the signing key / partition (e.g. a tenant id, an
 *   account id, or any opaque scope identifier). It MAY contain `.`.
 * - `resourceId` is an opaque application identifier (e.g. a conversation,
 *   thread, or ticket id). It MUST NOT contain `.` — it is the single
 *   second-to-last dot segment.
 * - `tag` is produced/verified by a caller-supplied signing service (a short,
 *   truncated HMAC over {@link replyAddressMessage}). It MUST NOT contain `.`.
 *
 * This module never touches crypto; it only builds and parses the address. The
 * returned `scopeKey` is only a key selector — the caller must still verify the
 * `tag` under that scope's signing key.
 */

/** Canonical message that gets signed — identical on sign and verify. */
export function replyAddressMessage(scopeKey: string, resourceId: string): string {
  return `${scopeKey}.${resourceId}`;
}

export interface ReplyAddressParts {
  scopeKey: string;
  resourceId: string;
  tag: string;
}

/**
 * Enforce the structural invariants {@link parseReplyAddress} relies on. Parsing
 * separates the local part from the domain at the LAST `@`, splits the local part
 * on `.`, and trims surrounding whitespace — so a segment carrying any of those
 * (plus the `+` prefix separator) would be silently mis-parsed and mis-scoped.
 *
 * Passing such a segment is a programming error, so this THROWS `TypeError`
 * rather than returning a `Result`: builders are called with values the code
 * controls, and a mis-scoped reply address must fail loud at construction.
 *
 * `resourceId` and `tag` must be dot-free (they are the last two dot segments);
 * `scopeKey` may contain `.` (it is everything before them).
 */
function assertSafeSegment(
  field: 'scopeKey' | 'resourceId' | 'tag',
  value: string,
  allowDot: boolean,
): void {
  if (value.length === 0) {
    throw new TypeError(`reply address ${field} must not be empty`);
  }
  if (!allowDot && value.includes('.')) {
    throw new TypeError(`reply address ${field} must not contain '.': ${JSON.stringify(value)}`);
  }
  if (/[@+\s]/.test(value)) {
    throw new TypeError(`reply address ${field} must not contain '@', '+', or whitespace: ${JSON.stringify(value)}`);
  }
}

function buildLocalPart(prefix: 'reply' | 'bounce', parts: ReplyAddressParts): string {
  assertSafeSegment('scopeKey', parts.scopeKey, true);
  assertSafeSegment('resourceId', parts.resourceId, false);
  assertSafeSegment('tag', parts.tag, false);
  return `${prefix}+${parts.scopeKey}.${parts.resourceId}.${parts.tag}`;
}

/**
 * Build the tagged Reply-To address (`reply+…`).
 *
 * @throws {TypeError} when `resourceId`/`tag` contain `.`, or any segment
 * contains `@`, `+`, or whitespace, or is empty — these would make the address
 * re-parse to different scope/resource/tag values (a programming error).
 */
export function buildReplyAddress(args: {
  scopeKey: string;
  resourceId: string;
  /** Short verification tag from the caller's signing service. Must not contain `.`. */
  tag: string;
  /** Inbound domain, e.g. `inbound.example.com`. */
  domain: string;
}): string {
  return `${buildLocalPart('reply', args)}@${args.domain}`;
}

/**
 * Build the tagged Return-Path / envelope-sender address (`bounce+…`).
 *
 * @throws {TypeError} on the same structurally-unsafe segments as
 * {@link buildReplyAddress}.
 */
export function buildReturnPath(args: {
  scopeKey: string;
  resourceId: string;
  tag: string;
  domain: string;
}): string {
  return `${buildLocalPart('bounce', args)}@${args.domain}`;
}

/**
 * Parse a single address into its tagged parts, or `null` if it does not match.
 *
 * Matching rules:
 * - domain (case-insensitive) must equal `domain`,
 * - local part must start with `reply+` or `bounce+`,
 * - after the prefix, split from the RIGHT on `.`: the last segment is `tag`,
 *   the second-to-last is `resourceId`, and EVERYTHING before that is the
 *   `scopeKey` (which itself may contain `.`).
 *
 * No crypto here — the returned `scopeKey` is only a key selector; the caller
 * must still verify the `tag` under that scope's signing key.
 */
function parseSingleAddress(address: string, domain: string): ReplyAddressParts | null {
  const trimmed = address.trim();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex === -1) return null;

  const localPart = trimmed.slice(0, atIndex);
  const addrDomain = trimmed.slice(atIndex + 1);
  if (addrDomain.toLowerCase() !== domain.toLowerCase()) return null;

  let rest: string;
  if (localPart.startsWith('reply+')) rest = localPart.slice('reply+'.length);
  else if (localPart.startsWith('bounce+')) rest = localPart.slice('bounce+'.length);
  else return null;

  // Split from the right: [...scopeKey].<resourceId>.<tag>
  const lastDot = rest.lastIndexOf('.');
  if (lastDot === -1) return null;
  const tag = rest.slice(lastDot + 1);

  const secondLastDot = rest.lastIndexOf('.', lastDot - 1);
  if (secondLastDot === -1) return null;
  const resourceId = rest.slice(secondLastDot + 1, lastDot);
  const scopeKey = rest.slice(0, secondLastDot);

  // All three segments must be non-empty. resourceId/tag are dot-free by
  // construction (they sit between the last two dots); scopeKey may contain dots.
  if (scopeKey.length === 0 || resourceId.length === 0 || tag.length === 0) return null;

  return { scopeKey, resourceId, tag };
}

/**
 * Find the first address in `addresses` (typically the union of To + Cc) that
 * parses as a tagged reply address for `domain`. Returns its parts, or `null`.
 */
export function parseReplyAddress(args: {
  addresses: string[];
  domain: string;
}): ReplyAddressParts | null {
  for (const address of args.addresses) {
    const parsed = parseSingleAddress(address, args.domain);
    if (parsed) return parsed;
  }
  return null;
}
