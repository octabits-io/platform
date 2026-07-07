import { describe, it, expect } from 'vitest';
import {
  replyAddressMessage,
  buildReplyAddress,
  buildReturnPath,
  parseReplyAddress,
} from './replyAddress';

const DOMAIN = 'inbound.example.com';

describe('replyAddressMessage', () => {
  it('joins scopeKey and resourceId with a dot', () => {
    expect(replyAddressMessage('19283746', '42')).toBe('19283746.42');
    expect(replyAddressMessage('scope-with-dash', 'r7')).toBe('scope-with-dash.r7');
  });
});

describe('buildReplyAddress / buildReturnPath', () => {
  it('builds reply+ and bounce+ local parts', () => {
    const args = { scopeKey: '19283746', resourceId: '42', tag: 'abc123', domain: DOMAIN };
    expect(buildReplyAddress(args)).toBe('reply+19283746.42.abc123@inbound.example.com');
    expect(buildReturnPath(args)).toBe('bounce+19283746.42.abc123@inbound.example.com');
  });

  it('allows a scopeKey that contains dots (round-trips unchanged)', () => {
    const args = { scopeKey: 'org.abc.123', resourceId: '42', tag: 'abc123', domain: DOMAIN };
    expect(buildReplyAddress(args)).toBe('reply+org.abc.123.42.abc123@inbound.example.com');
    const parsed = parseReplyAddress({ addresses: [buildReplyAddress(args)], domain: DOMAIN });
    expect(parsed).toEqual({ scopeKey: 'org.abc.123', resourceId: '42', tag: 'abc123' });
  });

  describe('rejects structurally-unsafe segments (programming error → TypeError)', () => {
    it('throws on a dotted resourceId (would mis-parse the boundary)', () => {
      expect(() => buildReplyAddress({ scopeKey: 's1', resourceId: 'conv.9', tag: 'abc123', domain: DOMAIN }))
        .toThrow(TypeError);
      expect(() => buildReturnPath({ scopeKey: 's1', resourceId: 'conv.9', tag: 'abc123', domain: DOMAIN }))
        .toThrow(/resourceId must not contain '\.'/);
    });

    it('throws on a dotted tag', () => {
      expect(() => buildReplyAddress({ scopeKey: 's1', resourceId: '42', tag: 'ab.cd', domain: DOMAIN }))
        .toThrow(/tag must not contain '\.'/);
    });

    it('throws on segments containing @, + or whitespace', () => {
      expect(() => buildReplyAddress({ scopeKey: 's@1', resourceId: '42', tag: 'abc', domain: DOMAIN }))
        .toThrow(/scopeKey/);
      expect(() => buildReplyAddress({ scopeKey: 's1', resourceId: 'a+b', tag: 'abc', domain: DOMAIN }))
        .toThrow(/resourceId/);
      expect(() => buildReplyAddress({ scopeKey: 's1', resourceId: '42', tag: 'ab cd', domain: DOMAIN }))
        .toThrow(/tag/);
    });

    it('throws on an empty segment', () => {
      expect(() => buildReplyAddress({ scopeKey: '', resourceId: '42', tag: 'abc', domain: DOMAIN }))
        .toThrow(/scopeKey must not be empty/);
    });

    it('leaves a valid round-trip unchanged', () => {
      const args = { scopeKey: 's1', resourceId: 'conv-9', tag: 'abc123', domain: DOMAIN };
      const parsed = parseReplyAddress({ addresses: [buildReplyAddress(args)], domain: DOMAIN });
      expect(parsed).toEqual({ scopeKey: 's1', resourceId: 'conv-9', tag: 'abc123' });
    });
  });
});

describe('parseReplyAddress', () => {
  it('round-trips a built reply address', () => {
    const tag = '0a1b2c3d4e5f60718293a4b5';
    const addr = buildReplyAddress({ scopeKey: '19283746', resourceId: '42', tag, domain: DOMAIN });
    const parsed = parseReplyAddress({ addresses: [addr], domain: DOMAIN });
    expect(parsed).toEqual({ scopeKey: '19283746', resourceId: '42', tag });
  });

  it('round-trips a built bounce/return-path address', () => {
    const tag = 'deadbeefdeadbeefdeadbeef';
    const addr = buildReturnPath({ scopeKey: '19283746', resourceId: 'r7', tag, domain: DOMAIN });
    const parsed = parseReplyAddress({ addresses: [addr], domain: DOMAIN });
    expect(parsed).toEqual({ scopeKey: '19283746', resourceId: 'r7', tag });
  });

  it('treats resourceId as opaque (non-numeric ids round-trip)', () => {
    const tag = '0123456789abcdef01234567';
    const addr = buildReplyAddress({ scopeKey: 's1', resourceId: 'conv-abc-9', tag, domain: DOMAIN });
    const parsed = parseReplyAddress({ addresses: [addr], domain: DOMAIN });
    expect(parsed).toEqual({ scopeKey: 's1', resourceId: 'conv-abc-9', tag });
  });

  it('handles scope keys that contain dots (split from the right)', () => {
    const tag = '0123456789abcdef01234567';
    const addr = `reply+org.abc.123.999.${tag}@${DOMAIN}`;
    const parsed = parseReplyAddress({ addresses: [addr], domain: DOMAIN });
    // resourceId is the second-to-last segment; everything before is the scopeKey.
    expect(parsed).toEqual({ scopeKey: 'org.abc.123', resourceId: '999', tag });
  });

  it('picks the tagged address out of a mixed To/Cc list', () => {
    const tag = 'aaaabbbbccccddddeeeeffff';
    const tagged = buildReplyAddress({ scopeKey: 's1', resourceId: '5', tag, domain: DOMAIN });
    const parsed = parseReplyAddress({
      addresses: ['someone@example.com', 'ops@inbound.example.com', tagged, 'cc@example.com'],
      domain: DOMAIN,
    });
    expect(parsed).toEqual({ scopeKey: 's1', resourceId: '5', tag });
  });

  it('is case-insensitive on the domain', () => {
    const tag = 'aaaabbbbccccddddeeeeffff';
    const addr = `reply+s1.5.${tag}@INBOUND.EXAMPLE.COM`;
    const parsed = parseReplyAddress({ addresses: [addr], domain: DOMAIN });
    expect(parsed).toEqual({ scopeKey: 's1', resourceId: '5', tag });
  });

  it('returns null for a non-matching domain', () => {
    const tag = 'aaaabbbbccccddddeeeeffff';
    const addr = `reply+s1.5.${tag}@evil.example.com`;
    expect(parseReplyAddress({ addresses: [addr], domain: DOMAIN })).toBeNull();
  });

  it('returns null for a plain address without the reply/bounce prefix', () => {
    expect(parseReplyAddress({ addresses: ['guest@inbound.example.com'], domain: DOMAIN })).toBeNull();
  });

  it('returns null when the local part lacks enough segments', () => {
    expect(parseReplyAddress({ addresses: [`reply+onlyonepart@${DOMAIN}`], domain: DOMAIN })).toBeNull();
    expect(parseReplyAddress({ addresses: [`reply+s1.notenough@${DOMAIN}`], domain: DOMAIN })).toBeNull();
  });

  it('returns null when a required segment is empty', () => {
    const tag = 'aaaabbbbccccddddeeeeffff';
    // Empty resourceId (two adjacent dots).
    expect(parseReplyAddress({ addresses: [`reply+s1..${tag}@${DOMAIN}`], domain: DOMAIN })).toBeNull();
    // Empty tag (trailing dot).
    expect(parseReplyAddress({ addresses: [`reply+s1.5.@${DOMAIN}`], domain: DOMAIN })).toBeNull();
  });

  it('returns null for an empty address list', () => {
    expect(parseReplyAddress({ addresses: [], domain: DOMAIN })).toBeNull();
  });
});
