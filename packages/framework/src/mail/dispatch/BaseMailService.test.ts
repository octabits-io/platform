import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBaseMailService, type OnSendCallback } from './BaseMailService';
import type { RenderedEmail } from '../base/errors';
import type {
  UserMailParams,
  SystemMailParams,
  MailConfigReader,
  MailTemplateRegistry,
  ResolvedMailConfig,
  ScopedMailServerConfig,
} from './types';
import { createMemoryTransport, type MemoryTransport } from '../providers/memory/MemoryTransport';
import type { MailTransport } from '../base/transport';
import type { MailDeliveryError } from '../base/errors';
import type { Logger } from '../../logger/index.ts';

// ============================================================================
// Test fixtures
// ============================================================================

type TestOverrides = { footer?: string };

interface UserParams extends UserMailParams {
  type: 'user-mail';
}
interface SystemParams extends SystemMailParams {
  type: 'system-mail';
}
type Params = UserParams | SystemParams;

interface TestServerConfig extends ScopedMailServerConfig {
  provider: 'smtp' | 'brevo';
}

const mockLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
};

function mockBuilder(over: {
  subject?: string;
  html?: unknown;
  text?: unknown;
} = {}) {
  return {
    buildSubject: vi.fn().mockResolvedValue({ ok: true, value: over.subject ?? 'Test Subject' }),
    buildHtmlContent: vi.fn().mockResolvedValue(over.html ?? { ok: true, value: '<p>Test HTML</p>' }),
    buildTextContent: vi.fn().mockResolvedValue(over.text ?? { ok: true, value: 'Test Text' }),
  };
}

function registry(over: Partial<MailTemplateRegistry<TestOverrides>> = {}): MailTemplateRegistry<TestOverrides> {
  return {
    'user-mail': mockBuilder(),
    'system-mail': mockBuilder(),
    ...over,
  };
}

/** Build a config reader that returns a fixed resolved config (or undefined). */
function configReaderOf(
  cfg: ResolvedMailConfig<TestOverrides, TestServerConfig> | undefined,
): MailConfigReader<Params, TestOverrides, TestServerConfig> {
  return async () => cfg;
}

function userParams(over: Partial<UserParams> = {}): UserParams {
  return { type: 'user-mail', email: 'customer@example.com', ...over };
}
function systemParams(over: Partial<SystemParams> = {}): SystemParams {
  return { type: 'system-mail', recipient: 'admin', ...over };
}

// ============================================================================
// Tests
// ============================================================================

describe('createBaseMailService', () => {
  let transport: MemoryTransport;

  beforeEach(() => {
    transport = createMemoryTransport();
  });

  describe('transport selection', () => {
    it('uses the global transport with the platform identity when there is no scope config', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        platformFromName: 'Example',
        templates: registry(),
        transport,
        logger: mockLogger,
      });

      const result = await service.send(userParams());

      expect(result.ok).toBe(true);
      expect(transport.count()).toBe(1);
      const message = transport.getLastMessage()!;
      expect(message.from).toEqual({ address: 'noreply@example.com', name: 'Example' });
      expect(message.to).toEqual(['customer@example.com']);
      expect(message.subject).toBe('Test Subject');
      expect(message.html).toBe('<p>Test HTML</p>');
      expect(message.text).toBe('Test Text');
    });

    it('routes via the scoped server transport when a mail server config is active', async () => {
      const scopedTransport = createMemoryTransport();
      const transportFactory = vi.fn().mockReturnValue(scopedTransport);

      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({
          mailServerConfig: { provider: 'smtp', fromAddress: 'server@scope.example', fromName: 'Scope Server' },
        }),
        transportFactory,
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());

      // Delivered via the scoped transport, not the global one.
      expect(scopedTransport.count()).toBe(1);
      expect(transport.count()).toBe(0);
      expect(transportFactory).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'smtp', fromAddress: 'server@scope.example' }),
      );
      const message = scopedTransport.getLastMessage()!;
      expect(message.from).toEqual({ address: 'server@scope.example', name: 'Scope Server' });
      // No Reply-To injection when the scope has its own server.
      expect(message.replyTo).toBeUndefined();
    });

    it('falls back to the platform transport (From = "<scope> via <brand>", Reply-To = notifications) when no server is active', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        platformFromName: 'Example',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());

      const message = transport.getLastMessage()!;
      expect(message.from).toEqual({ address: 'noreply@example.com', name: 'Acme via Example' });
      expect(message.replyTo).toEqual({ address: 'admin@acme.example', name: 'Acme' });
      expect(message.to).toEqual(['customer@example.com']);
    });

    it('uses platformBrandName for the "via" label when provided', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        platformFromName: 'Example',
        platformBrandName: 'Platform',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme' }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());
      expect(transport.getLastMessage()!.from.name).toBe('Acme via Platform');
    });

    it('omits Reply-To on platform fallback when the scope has no notifications address', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme' }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());
      expect(transport.getLastMessage()!.replyTo).toBeUndefined();
    });

    it('bypasses an active mail server when mailServerEnabled is false (falls back)', async () => {
      const scopedTransport = createMemoryTransport();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        platformFromName: 'Example',
        templates: registry(),
        configReader: configReaderOf({
          scopeName: 'Acme',
          mailServerEnabled: false,
          mailServerConfig: { provider: 'smtp', fromAddress: 'server@scope.example' },
        }),
        transportFactory: () => scopedTransport,
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());
      expect(scopedTransport.count()).toBe(0);
      expect(transport.getLastMessage()!.from.name).toBe('Acme via Example');
    });

    it('returns mail_not_configured when no server is active and platform fallback is disabled', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ platformFallbackEnabled: false }),
        transport,
        logger: mockLogger,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('mail_not_configured');
      expect(transport.count()).toBe(0);
    });
  });

  describe('delivery-mode resolution', () => {
    it('delivers to the user in default mode', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'default', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());
      expect(transport.getLastMessage()!.to).toEqual(['customer@example.com']);
    });

    it('redirects to the notifications address in notifications_only mode', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'notifications_only', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());
      expect(transport.getLastMessage()!.to).toEqual(['admin@acme.example']);
    });

    it('BCCs the notifications address in customer_and_notifications mode (never visible in to)', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'customer_and_notifications', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());
      const message = transport.getLastMessage()!;
      expect(message.to).toEqual(['customer@example.com']);
      expect(message.to).not.toContain('admin@acme.example');
      expect(message.bcc).toEqual(['admin@acme.example']);
    });

    it('degrades customer_and_notifications to default (user only) when no notifications address', async () => {
      const warn = vi.fn();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'customer_and_notifications' }),
        transport,
        logger: { ...mockLogger, warn },
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(true);
      expect(transport.getLastMessage()!.to).toEqual(['customer@example.com']);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('degraded to default'),
        expect.objectContaining({ type: 'user-mail' }),
      );
    });

    it('returns mail_not_configured for notifications_only with no notifications address', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'notifications_only' }),
        transport,
        logger: mockLogger,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('mail_not_configured');
      expect(transport.count()).toBe(0);
    });

    it('applies the redirect subject prefix when the user mail is redirected', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry({ 'user-mail': mockBuilder({ subject: 'Your order shipped' }) }),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'notifications_only', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());
      expect(transport.getLastMessage()!.subject).toBe('[→ customer@example.com] Your order shipped');
    });
  });

  describe('classification (system vs user)', () => {
    it('routes system mail to the notifications address by default classifier', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      await service.send(systemParams());
      expect(transport.getLastMessage()!.to).toEqual(['admin@acme.example']);
    });

    it('routes system mail to bypassRecipient when bypassDeliveryMode is set', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      await service.send(systemParams({ bypassDeliveryMode: true, bypassRecipient: 'dev@example.com' }));
      expect(transport.getLastMessage()!.to).toEqual(['dev@example.com']);
    });

    it('returns mail_not_configured for system mail with no notifications address', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme' }),
        transport,
        logger: mockLogger,
      });

      const result = await service.send(systemParams());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('mail_not_configured');
    });
  });

  describe('forceNotificationsOnlyDelivery', () => {
    it('forces user mail to the notifications address', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'default', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
        forceNotificationsOnlyDelivery: true,
      });

      await service.send(userParams());
      expect(transport.getLastMessage()!.to).toEqual(['admin@acme.example']);
    });

    it('exempts test mail with bypassDeliveryMode', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
        forceNotificationsOnlyDelivery: true,
      });

      await service.send(userParams({ bypassDeliveryMode: true }));
      expect(transport.getLastMessage()!.to).toEqual(['customer@example.com']);
    });
  });

  describe('dev-override redirect', () => {
    it('redirects scoped-server mail to the override recipient', async () => {
      const scopedTransport = createMemoryTransport();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({
          mailServerConfig: { provider: 'smtp', fromAddress: 'server@scope.example' },
        }),
        transportFactory: () => scopedTransport,
        transport,
        logger: mockLogger,
        devOverrideRecipient: 'dev@example.com',
      });

      await service.send(userParams());
      const message = scopedTransport.getLastMessage()!;
      // Recipient is overridden; the rest of the message is intact.
      expect(message.to).toEqual(['dev@example.com']);
      expect(message.from.address).toBe('server@scope.example');
    });

    it('redirects global/no-scope-config mail to the override recipient', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        platformFromName: 'Example',
        templates: registry(),
        // No configReader → the global transport / dev path.
        transport,
        logger: mockLogger,
        devOverrideRecipient: 'dev@example.com',
      });

      await service.send(userParams());
      const message = transport.getLastMessage()!;
      expect(message.to).toEqual(['dev@example.com']);
      expect(message.from).toEqual({ address: 'noreply@example.com', name: 'Example' });
    });

    it('drops the notifications BCC when redirecting (no leak through the blind copy)', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({
          scopeName: 'Acme',
          deliveryMode: 'customer_and_notifications',
          notificationsAddress: 'admin@acme.example',
        }),
        transport,
        logger: mockLogger,
        devOverrideRecipient: 'dev@example.com',
      });

      await service.send(userParams());
      const message = transport.getLastMessage()!;
      expect(message.to).toEqual(['dev@example.com']);
      expect(message.bcc).toBeUndefined();
    });

    it('redirects platform-fallback mail to the override recipient', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        platformFromName: 'Example',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
        devOverrideRecipient: 'dev@example.com',
      });

      await service.send(userParams());
      const message = transport.getLastMessage()!;
      // Delivered via the platform fallback, but redirected to the override.
      expect(message.to).toEqual(['dev@example.com']);
      expect(message.from).toEqual({ address: 'noreply@example.com', name: 'Acme via Example' });
    });
  });

  describe('recipient sanitization + header-injection guard', () => {
    it('rejects a comma-smuggled recipient (invalid_recipient) without touching the transport', async () => {
      const onSend = vi.fn();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        transport,
        logger: mockLogger,
        onSend,
      });

      const result = await service.send(userParams({ email: 'victim@example.com,attacker@evil.example' }));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('invalid_recipient');
      expect(transport.count()).toBe(0);
      // The refusal still reaches the delivery log.
      expect(onSend).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        expect.objectContaining({ ok: false, error: expect.objectContaining({ key: 'invalid_recipient' }) }),
        { viaPlatformFallback: false },
      );
    });

    it('rejects recipients with semicolons, angle brackets, whitespace, or a non-email shape', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        transport,
        logger: mockLogger,
      });

      for (const email of [
        'a@example.com;b@example.com',
        '<attacker@evil.example>',
        'a b@example.com',
        'a@example.com\r\nBcc: x@evil.example',
        'not-an-email',
      ]) {
        const result = await service.send(userParams({ email }));
        expect(result.ok, email).toBe(false);
        if (!result.ok) expect(result.error.key).toBe('invalid_recipient');
      }
      expect(transport.count()).toBe(0);
    });

    it('rejects a smuggled caller-supplied replyTo address', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        transport,
        logger: mockLogger,
      });

      const result = await service.send(userParams({
        replyTo: { address: 'reply@ok.example,evil@evil.example' },
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('invalid_recipient');
      expect(transport.count()).toBe(0);
    });

    it('strips CRLF from the subject before it reaches the transport', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry({ 'user-mail': mockBuilder({ subject: 'Hello\r\nBcc: evil@evil.example' }) }),
        transport,
        logger: mockLogger,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(true);
      const message = transport.getLastMessage()!;
      expect(message.subject).toBe('Hello Bcc: evil@evil.example');
      expect(message.subject).not.toMatch(/[\r\n]/);
    });

    it('strips CRLF from scope-derived display strings (scopeName in from name and reply-to name)', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        platformFromName: 'Example',
        templates: registry(),
        configReader: configReaderOf({
          scopeName: 'Acme\r\nX-Evil: 1',
          notificationsAddress: 'admin@acme.example',
        }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());
      const message = transport.getLastMessage()!;
      expect(message.from.name).toBe('Acme X-Evil: 1 via Example');
      expect(message.from.name).not.toMatch(/[\r\n]/);
      expect(message.replyTo!.name).not.toMatch(/[\r\n]/);
    });

    it('refuses user mail whose params carry no email (never sends to: [undefined])', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        transport,
        logger: mockLogger,
      });

      const result = await service.send(userParams({ email: undefined as unknown as string }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('invalid_recipient');
      expect(transport.count()).toBe(0);
    });
  });

  describe('caller-supplied reply routing', () => {
    it('lets params.replyTo / params.returnPath win over the computed fallback', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams({
        replyTo: { address: 'reply+s1.5.tag@inbound.example.com' },
        returnPath: { address: 'bounce+s1.5.tag@inbound.example.com' },
      }));

      const message = transport.getLastMessage()!;
      expect(message.replyTo).toEqual({ address: 'reply+s1.5.tag@inbound.example.com' });
      expect(message.returnPath).toEqual({ address: 'bounce+s1.5.tag@inbound.example.com' });
    });
  });

  describe('onSend hook', () => {
    it('fires with the params, message, result and metadata after a successful send', async () => {
      const onSend = vi.fn();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
        onSend,
      });

      const params = userParams();
      await service.send(params);

      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith(
        params,
        expect.objectContaining({ to: ['customer@example.com'] }),
        { ok: true, value: { messageId: expect.any(String) } },
        { viaPlatformFallback: true },
      );
    });

    it('reports viaPlatformFallback=false for scoped-server sends', async () => {
      const onSend = vi.fn();
      const scopedTransport = createMemoryTransport();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ mailServerConfig: { provider: 'smtp', fromAddress: 'server@scope.example' } }),
        transportFactory: () => scopedTransport,
        transport,
        logger: mockLogger,
        onSend,
      });

      await service.send(userParams());
      expect(onSend).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ ok: true }),
        { viaPlatformFallback: false },
      );
    });

    it('fires after a failed send', async () => {
      const onSend = vi.fn();
      const failing: MailTransport = {
        type: 'failing',
        send: vi.fn().mockResolvedValue({ ok: false, error: { key: 'mail_delivery_error', message: 'boom' } as MailDeliveryError }),
      };
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        transport: failing,
        logger: mockLogger,
        onSend,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(false);
      expect(onSend).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ ok: false, error: expect.objectContaining({ key: 'mail_delivery_error' }) }),
        { viaPlatformFallback: false },
      );
    });

    it('fires with the refusal (message undefined) when the template is missing', async () => {
      const onSend = vi.fn();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry({ 'user-mail': undefined as never }),
        transport,
        logger: mockLogger,
        onSend,
      });

      const params = userParams();
      const result = await service.send(params);
      expect(result.ok).toBe(false);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith(
        params,
        undefined,
        expect.objectContaining({ ok: false, error: expect.objectContaining({ key: 'mail_template_error' }) }),
        { viaPlatformFallback: false },
      );
    });

    it('fires with the refusal and logs a warning for a mail_not_configured refusal (notifications_only, no address)', async () => {
      const onSend = vi.fn();
      const warn = vi.fn();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'notifications_only' }),
        transport,
        logger: { ...mockLogger, warn },
        onSend,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(false);
      expect(onSend).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        expect.objectContaining({ ok: false, error: expect.objectContaining({ key: 'mail_not_configured' }) }),
        { viaPlatformFallback: false },
      );
      expect(warn).toHaveBeenCalledWith(
        'Mail refused: not configured',
        expect.objectContaining({ type: 'user-mail' }),
      );
    });

    it('fires with the refusal when platform fallback is disabled', async () => {
      const onSend = vi.fn();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ platformFallbackEnabled: false }),
        transport,
        logger: mockLogger,
        onSend,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(false);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        expect.objectContaining({ ok: false, error: expect.objectContaining({ key: 'mail_not_configured' }) }),
        { viaPlatformFallback: false },
      );
    });

    it('swallows onSend errors on a refusal path and still returns the refusal', async () => {
      const onSend: OnSendCallback<Params> = vi.fn().mockRejectedValue(new Error('hook boom'));
      const error = vi.fn();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ platformFallbackEnabled: false }),
        transport,
        logger: { ...mockLogger, error },
        onSend,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('mail_not_configured');
      expect(error).toHaveBeenCalledWith('onSend callback failed', expect.any(Error));
    });

    it('swallows onSend errors and still resolves successfully', async () => {
      const onSend: OnSendCallback<Params> = vi.fn().mockRejectedValue(new Error('hook boom'));
      const error = vi.fn();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        transport,
        logger: { ...mockLogger, error },
        onSend,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(true);
      expect(error).toHaveBeenCalledWith('onSend callback failed', expect.any(Error));
    });
  });

  describe('template rendering', () => {
    it('returns mail_template_error when no template is registered for the type', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry({ 'user-mail': undefined as never }),
        transport,
        logger: mockLogger,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('mail_template_error');
        expect(result.error.message).toContain('user-mail');
      }
    });

    it('propagates a template build failure', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry({
          'user-mail': mockBuilder({ html: { ok: false, error: { key: 'mail_template_error', message: 'render failed' } } }),
        }),
        transport,
        logger: mockLogger,
      });

      const result = await service.send(userParams());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('mail_template_error');
      expect(transport.count()).toBe(0);
    });

    it('threads the scope locale into params when the caller did not set one', async () => {
      const builder = mockBuilder();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry({ 'user-mail': builder }),
        configReader: configReaderOf({ scopeName: 'Acme', locale: 'de', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      await service.send(userParams());
      expect(builder.buildSubject).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de' }));
    });
  });

  describe('render()', () => {
    it('returns subject/html/text/recipients without sending', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry({ 'user-mail': mockBuilder({ subject: 'Preview me' }) }),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'notifications_only', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      const result = await service.render(userParams());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.subject).toBe('[→ customer@example.com] Preview me');
      expect(result.value.recipients).toEqual(['admin@acme.example']);
      expect(result.value.primaryRecipient).toBe('customer@example.com');
      // Nothing was actually delivered.
      expect(transport.count()).toBe(0);
    });

    it('surfaces the notifications BCC in customer_and_notifications mode', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'customer_and_notifications', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      const result = await service.render(userParams());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.recipients).toEqual(['customer@example.com']);
      expect(result.value.bcc).toEqual(['admin@acme.example']);
    });
  });

  describe('dispatchRendered()', () => {
    /** Render a message via the service, returning the frozen RenderedEmail. */
    async function renderOf(
      service: ReturnType<typeof createBaseMailService<Params, TestOverrides, TestServerConfig>>,
      params: Params,
    ): Promise<RenderedEmail> {
      const rendered = await service.render(params);
      if (!rendered.ok) throw new Error(`render failed: ${rendered.error.key}`);
      return rendered.value;
    }

    it('delivers a previously-rendered email verbatim, recomputing routing against current config', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        platformFromName: 'Example',
        templates: registry({ 'user-mail': mockBuilder({ subject: 'Rendered earlier' }) }),
        configReader: configReaderOf({ scopeName: 'Acme', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      const params = userParams();
      const rendered = await renderOf(service, params);
      expect(transport.count()).toBe(0); // render never delivers

      const result = await service.dispatchRendered(params, rendered);
      expect(result.ok).toBe(true);
      expect(transport.count()).toBe(1);
      const message = transport.getLastMessage()!;
      // Content taken verbatim from the rendered snapshot; routing recomputed.
      expect(message.subject).toBe('Rendered earlier');
      expect(message.to).toEqual(['customer@example.com']);
      expect(message.from).toEqual({ address: 'noreply@example.com', name: 'Acme via Example' });
      expect(message.replyTo).toEqual({ address: 'admin@acme.example', name: 'Acme' });
    });

    it('does not re-render the template on dispatch', async () => {
      const builder = mockBuilder({ subject: 'Once' });
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry({ 'user-mail': builder }),
        transport,
        logger: mockLogger,
      });

      const params = userParams();
      const rendered = await renderOf(service, params);
      builder.buildSubject.mockClear();
      builder.buildHtmlContent.mockClear();
      builder.buildTextContent.mockClear();

      await service.dispatchRendered(params, rendered);
      expect(builder.buildSubject).not.toHaveBeenCalled();
      expect(builder.buildHtmlContent).not.toHaveBeenCalled();
      expect(builder.buildTextContent).not.toHaveBeenCalled();
    });

    it('reflects a config change made between render and dispatch (scoped server activated)', async () => {
      const scopedTransport = createMemoryTransport();
      // configReader returns platform-fallback config on first call, a scoped
      // server on the second (the dispatch-time re-read).
      const reads: (ResolvedMailConfig<TestOverrides, TestServerConfig> | undefined)[] = [
        { scopeName: 'Acme', notificationsAddress: 'admin@acme.example' },
        { mailServerConfig: { provider: 'smtp', fromAddress: 'server@scope.example', fromName: 'Scope Server' } },
      ];
      let call = 0;
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        platformFromName: 'Example',
        templates: registry(),
        configReader: async () => reads[call++],
        transportFactory: () => scopedTransport,
        transport,
        logger: mockLogger,
      });

      const params = userParams();
      const rendered = await renderOf(service, params); // read #0 (platform fallback)
      await service.dispatchRendered(params, rendered);  // read #1 (scoped server now active)

      // Delivered via the newly-active scoped transport, using its From.
      expect(scopedTransport.count()).toBe(1);
      expect(transport.count()).toBe(0);
      expect(scopedTransport.getLastMessage()!.from).toEqual({ address: 'server@scope.example', name: 'Scope Server' });
    });

    it('fires onSend for the delivery', async () => {
      const onSend = vi.fn();
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        transport,
        logger: mockLogger,
        onSend,
      });

      const params = userParams();
      const rendered = await renderOf(service, params);
      onSend.mockClear();

      await service.dispatchRendered(params, rendered);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith(
        params,
        expect.objectContaining({ to: ['customer@example.com'] }),
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ viaPlatformFallback: false }),
      );
    });

    it('re-runs the header-injection guard before any transport contact', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        transport,
        logger: mockLogger,
      });

      const rendered = await renderOf(service, userParams());
      // Tamper with the rendered recipients before re-dispatch.
      const tampered: RenderedEmail = { ...rendered, recipients: ['victim@example.com,attacker@evil.example'] };

      const result = await service.dispatchRendered(userParams(), tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.key).toBe('invalid_recipient');
      expect(transport.count()).toBe(0);
    });

    it('carries the BCC from the rendered snapshot through to the transport', async () => {
      const service = createBaseMailService<Params, TestOverrides, TestServerConfig>({
        platformFromAddress: 'noreply@example.com',
        templates: registry(),
        configReader: configReaderOf({ scopeName: 'Acme', deliveryMode: 'customer_and_notifications', notificationsAddress: 'admin@acme.example' }),
        transport,
        logger: mockLogger,
      });

      const params = userParams();
      const rendered = await renderOf(service, params);
      expect(rendered.bcc).toEqual(['admin@acme.example']);

      await service.dispatchRendered(params, rendered);
      const message = transport.getLastMessage()!;
      expect(message.to).toEqual(['customer@example.com']);
      expect(message.bcc).toEqual(['admin@acme.example']);
    });
  });
});
