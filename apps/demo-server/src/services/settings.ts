/**
 * Settings — `createScopedConfigService` (`…/drizzle/config`) over the
 * key/value `settings` table, **unscoped** (single-scope deployment).
 *
 * The engine is validate → encrypt → cache → default. Two details do the heavy
 * lifting here:
 *   - The schema seam is structural: anything with a
 *     `safeParse({key, value}) → {success, data:{value}}` shape satisfies it, so
 *     a `z.discriminatedUnion('key', …)` drops straight in.
 *   - Per-key `.default(...)` is what makes a *missing row* read back as the
 *     documented default — `readAll()` needs the `keys` list to know which keys
 *     to apply defaults for.
 *
 * `cipher` is left unwired: nothing here is a secret. It is the seam you would
 * pass `…/pii`'s encrypt/decrypt through (base64 in, base64 out) to encrypt a
 * key at rest — the config module never imports pii itself.
 */
import { z } from 'zod';
import { createScopedConfigService } from '@octabits-io/framework/drizzle/config';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import type { Logger } from '@octabits-io/framework/logger';
import { settings, type Schema } from '../db/schema.ts';

export const SCHEMA_SETTINGS_VALUE = z.discriminatedUnion('key', [
  z.object({
    key: z.literal('supportEmail'),
    value: z.email().default('support@demo.example'),
  }),
  z.object({
    key: z.literal('welcomeSubject'),
    value: z.string().min(1).max(200).default('Welcome to the contact desk'),
  }),
]);

export interface SettingsMap extends Record<string, unknown> {
  supportEmail: string;
  welcomeSubject: string;
}

export const SETTINGS_KEYS = ['supportEmail', 'welcomeSubject'] as const;

export interface SettingsServiceDeps {
  db: AppDatabase<Schema>;
  logger: Logger;
}

export function createSettingsService({ db, logger }: SettingsServiceDeps) {
  return createScopedConfigService<SettingsMap>({
    db,
    table: settings,
    schema: SCHEMA_SETTINGS_VALUE,
    keys: SETTINGS_KEYS,
    logger,
  });
}

export type SettingsService = ReturnType<typeof createSettingsService>;
