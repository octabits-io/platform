/**
 * IoC wiring (`…/ioc`).
 *
 * Three lifetimes are available: Singleton (cached at the root), Scoped (cached
 * per `createScope()`), Transient (fresh every resolve). This app is small
 * enough that everything is a Singleton — the container earns its place by
 * giving the queue worker a `createSystemScope` seam.
 *
 * That seam is why `IoC` and `@octabits-io/framework/queue` fit together with no
 * adapter: `defineQueue`'s `QueueScope` (`resolve` + `dispose`) is a structural
 * subset of IoC's `DisposableServiceResolver`, so a scope passes straight in.
 * The queue module never imports the IoC module.
 */
import { IoC, ServiceLifetime } from '@octabits-io/framework/ioc';
import type { DisposableServiceResolver } from '@octabits-io/framework/ioc';
import type { Logger } from '@octabits-io/framework/logger';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import type { IdempotencyService } from '@octabits-io/framework/drizzle/idempotency';
import { createIdempotencyService } from '@octabits-io/framework/drizzle/idempotency';
import type { ObjectStorageService } from '@octabits-io/framework/storage';
import type { BossManager } from '@octabits-io/framework/queue';
import type { TypedCaptchaService } from '@octabits-io/framework/captcha';
import { createNoopCaptchaService } from '@octabits-io/framework/captcha';
import { createDateProvider } from '@octabits-io/framework/utils';
import type { DateProvider } from '@octabits-io/framework/utils';
import type { BlindIndexService, PiiEncryptionService } from '@octabits-io/framework/pii';
import { createBlindIndexService, createPiiEncryptionService, identityToRecipient } from '@octabits-io/framework/pii';
import type { Schema } from './db/schema.ts';
import { idempotencyKey } from './db/schema.ts';
import { createContactsService, type ContactsService } from './services/contacts.ts';
import { createNotesService, type NotesService } from './services/notes.ts';
import { createSettingsService, type SettingsService } from './services/settings.ts';
import { createDemoMailService, type DemoMailService } from './services/mail.ts';
import type { AppConfig } from './config.ts';

/** The service map. `resolve()` is typed against this. */
export interface DemoServices {
  logger: Logger;
  config: AppConfig;
  db: AppDatabase<Schema>;
  dateProvider: DateProvider;
  pii: PiiEncryptionService;
  blindIndex: BlindIndexService;
  storage: ObjectStorageService;
  boss: BossManager;
  captcha: TypedCaptchaService;
  contactsService: ContactsService;
  notesService: NotesService;
  settingsService: SettingsService;
  mailService: DemoMailService;
  idempotency: IdempotencyService;
}

export interface BuildContainerDeps {
  config: AppConfig;
  logger: Logger;
  db: AppDatabase<Schema>;
  storage: ObjectStorageService;
  boss: BossManager;
}

export async function buildContainer(deps: BuildContainerDeps): Promise<IoC<DemoServices>> {
  const container = new IoC<DemoServices>();

  // The age recipient (public key) is derived from the identity (private key),
  // so only one secret is ever configured.
  const recipient = await identityToRecipient(deps.config.pii.ageIdentity);

  const single = ServiceLifetime.Singleton;

  container.register('logger', () => deps.logger, single);
  container.register('config', () => deps.config, single);
  container.register('db', () => deps.db, single);
  container.register('storage', () => deps.storage, single);
  container.register('boss', () => deps.boss, single);
  container.register('dateProvider', () => createDateProvider(), single);

  container.register(
    'pii',
    () => createPiiEncryptionService({ recipient, identity: deps.config.pii.ageIdentity }),
    single,
  );
  container.register('blindIndex', () => createBlindIndexService(deps.config.pii.blindIndexKey), single);
  container.register('captcha', (c) => createNoopCaptchaService({ logger: c.resolve('logger') }), single);

  container.register(
    'contactsService',
    (c) =>
      createContactsService({
        db: c.resolve('db'),
        pii: c.resolve('pii'),
        blindIndex: c.resolve('blindIndex'),
        dateProvider: c.resolve('dateProvider'),
      }),
    single,
  );
  container.register(
    'notesService',
    (c) => createNotesService({ db: c.resolve('db'), dateProvider: c.resolve('dateProvider') }),
    single,
  );
  // Transient, not Singleton: the config service caches reads for one unit of
  // work and invalidates only on writes made through that same instance. A
  // process-wide singleton would therefore serve stale config after *another*
  // process wrote — so each resolve gets a fresh instance with an empty cache.
  container.register(
    'settingsService',
    (c) => createSettingsService({ db: c.resolve('db'), logger: c.resolve('logger') }),
    ServiceLifetime.Transient,
  );
  container.register(
    'mailService',
    (c) =>
      createDemoMailService({
        logger: c.resolve('logger'),
        // Resolved from the root container per send. Capturing `c` would pin a
        // scope that may already be disposed by the time a job sends.
        settings: () => container.resolve('settingsService'),
        platformFromAddress: deps.config.mail.fromAddress,
        platformFromName: deps.config.mail.fromName,
      }),
    single,
  );
  container.register(
    'idempotency',
    (c) =>
      createIdempotencyService({
        db: c.resolve('db'),
        table: idempotencyKey,
        dateProvider: c.resolve('dateProvider'),
        logger: c.resolve('logger'),
      }),
    single,
  );

  return container;
}

/**
 * `QueueScopeFactory`-shaped seam handed to the queue worker + DLQ handler.
 * `scopeKey` is ignored: this app has a single scope, so there is nothing to
 * partition by.
 */
export function createSystemScopeFactory(
  container: IoC<DemoServices>,
): () => Promise<DisposableServiceResolver<DemoServices>> {
  return async () => container.createScope();
}

/** Services that exist only inside a request scope. */
export interface DemoRequestServices {
  /** The `x-demo-role` header — a real app maps this from a validated JWT claim. */
  role: string | undefined;
}

/**
 * Seed one request's scope (consumed by `request-scope.ts`'s plugin wiring).
 *
 * The `settingsService` re-registration narrows the root's Transient lifetime
 * to Scoped *for this request*: the service's read cache is per-unit-of-work,
 * and here the request is the unit — one instance, one warm cache, gone when
 * the plugin disposes the scope. The root registration stays Transient for
 * non-request callers (the queue worker's mail path).
 */
export function createDemoRequestScope(
  container: IoC<DemoServices>,
  request: Request,
): IoC<DemoRequestServices & DemoServices> {
  const scope = container.createScope<DemoRequestServices>();
  const role = request.headers.get('x-demo-role') ?? undefined;
  scope.register('role', () => role, ServiceLifetime.Scoped);
  scope.register(
    'settingsService',
    (c) => createSettingsService({ db: c.resolve('db'), logger: c.resolve('logger') }),
    ServiceLifetime.Scoped,
  );
  return scope;
}
