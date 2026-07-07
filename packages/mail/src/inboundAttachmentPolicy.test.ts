import { describe, it, expect } from 'vitest';

import {
  MAX_INBOUND_ATTACHMENT_BYTES,
  fileExtension,
  screenInboundAttachment,
} from './inboundAttachmentPolicy';

const ok = (over: Partial<Parameters<typeof screenInboundAttachment>[0]> = {}) => ({
  name: 'photo.jpg',
  contentType: 'image/jpeg',
  contentLength: 1024,
  ...over,
});

describe('fileExtension', () => {
  it('returns the lower-cased final extension', () => {
    expect(fileExtension('invoice.PDF')).toBe('pdf');
    expect(fileExtension('archive.tar.gz')).toBe('gz');
  });

  it('returns empty for names without a usable extension', () => {
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.gitignore')).toBe(''); // leading dot only
    expect(fileExtension('trailing.')).toBe('');
  });

  it('strips trailing dots/spaces before extracting (Windows drops them on save)', () => {
    expect(fileExtension('invoice.exe.')).toBe('exe');
    expect(fileExtension('invoice.exe ')).toBe('exe');
    expect(fileExtension('invoice.exe. . ')).toBe('exe');
  });

  it('ignores directory separators in the name', () => {
    expect(fileExtension('a/b/c.exe')).toBe('exe');
    expect(fileExtension('a\\b\\c.bat')).toBe('bat');
  });
});

describe('screenInboundAttachment', () => {
  it('allows ordinary documents and images', () => {
    expect(screenInboundAttachment(ok()).blocked).toBe(false);
    expect(screenInboundAttachment(ok({ name: 'passport.pdf', contentType: 'application/pdf' })).blocked).toBe(false);
    expect(screenInboundAttachment(ok({ name: 'notes.txt', contentType: 'text/plain' })).blocked).toBe(false);
  });

  it('does not block archives (scanning concern, not a blocklist one)', () => {
    expect(screenInboundAttachment(ok({ name: 'docs.zip', contentType: 'application/zip' })).blocked).toBe(false);
  });

  it('blocks dangerous extensions regardless of declared MIME', () => {
    for (const name of ['malware.exe', 'run.bat', 'a.scr', 'macro.docm', 'app.jar', 'script.ps1', 'thing.LNK']) {
      const r = screenInboundAttachment(ok({ name, contentType: 'application/octet-stream' }));
      expect(r.blocked, name).toBe(true);
      expect(r.code).toBe('blocked_extension');
    }
  });

  it('blocks the extended carrier set (add-ins, disk images, chm, url)', () => {
    for (const name of ['addin.xll', 'image.iso', 'disk.img', 'help.chm', 'link.url', 'disk.vhd', 'disk.vhdx']) {
      const r = screenInboundAttachment(ok({ name, contentType: 'application/octet-stream' }));
      expect(r.blocked, name).toBe(true);
      expect(r.code).toBe('blocked_extension');
    }
  });

  it('blocks trailing-dot/space bypass attempts (invoice.exe. / invoice.exe )', () => {
    for (const name of ['invoice.exe.', 'invoice.exe ', 'run.bat. ']) {
      const r = screenInboundAttachment(ok({ name, contentType: 'application/octet-stream' }));
      expect(r.blocked, JSON.stringify(name)).toBe(true);
      expect(r.code).toBe('blocked_extension');
    }
  });

  it('blocks double extensions by their final extension (name.pdf.exe)', () => {
    const r = screenInboundAttachment(ok({ name: 'name.pdf.exe', contentType: 'application/pdf' }));
    expect(r.blocked).toBe(true);
    expect(r.code).toBe('blocked_extension');
  });

  it('blocks dangerous MIME types even with an innocuous name', () => {
    const r = screenInboundAttachment(ok({ name: 'invoice', contentType: 'application/x-msdownload' }));
    expect(r.blocked).toBe(true);
    expect(r.code).toBe('blocked_type');
  });

  it('matches MIME case-insensitively', () => {
    const r = screenInboundAttachment(ok({ name: 'x', contentType: 'Application/X-MSDownload' }));
    expect(r.blocked).toBe(true);
  });

  it('blocks a dangerous MIME type carrying parameters (strips ; name=…)', () => {
    const r = screenInboundAttachment(ok({ name: 'invoice', contentType: 'application/x-msdownload; name="x"' }));
    expect(r.blocked).toBe(true);
    expect(r.code).toBe('blocked_type');
  });

  it('blocks a parameterized dangerous MIME type case-insensitively', () => {
    const r = screenInboundAttachment(ok({ name: 'invoice', contentType: 'Application/X-MSDownload; charset=binary' }));
    expect(r.blocked).toBe(true);
    expect(r.code).toBe('blocked_type');
  });

  it('still passes a benign MIME type that carries parameters', () => {
    const r = screenInboundAttachment(ok({ name: 'notes.txt', contentType: 'text/plain; charset=utf-8' }));
    expect(r.blocked).toBe(false);
  });

  it('blocks attachments over the declared size ceiling', () => {
    const r = screenInboundAttachment(ok({ contentLength: MAX_INBOUND_ATTACHMENT_BYTES + 1 }));
    expect(r.blocked).toBe(true);
    expect(r.code).toBe('too_large');
  });

  it('allows attachments exactly at the ceiling', () => {
    expect(screenInboundAttachment(ok({ contentLength: MAX_INBOUND_ATTACHMENT_BYTES })).blocked).toBe(false);
  });

  it('honors a caller-supplied policy override', () => {
    // Tighter size ceiling.
    const tight = screenInboundAttachment(ok({ contentLength: 2048 }), { maxBytes: 1024 });
    expect(tight.blocked).toBe(true);
    expect(tight.code).toBe('too_large');

    // Custom extension blocklist replaces the default (defaults no longer apply).
    const custom = screenInboundAttachment(
      ok({ name: 'thing.foo', contentType: 'application/octet-stream' }),
      { blockedExtensions: new Set(['foo']) },
    );
    expect(custom.blocked).toBe(true);
    expect(custom.code).toBe('blocked_extension');

    // An extension blocked by default is allowed when the override omits it.
    const allowed = screenInboundAttachment(
      ok({ name: 'run.exe', contentType: 'image/jpeg' }),
      { blockedExtensions: new Set(['foo']), blockedMimeTypes: new Set() },
    );
    expect(allowed.blocked).toBe(false);
  });
});
