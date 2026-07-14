/**
 * Schema and parser for the `VAULT_SECRETS_MANIFEST` env var.
 *
 * The manifest is a JSON-encoded list of (Vault KV path → env var) bindings.
 * Each entry maps Vault keys at a single KV path to the `process.env`
 * variables that should receive their values at boot time.
 *
 * Example:
 *   [
 *     {
 *       "path": "secret/data/myapp/api",
 *       "map": { "db_url": "DATABASE_URL", "stripe": "STRIPE_SECRET_KEY" }
 *     }
 *   ]
 */

import { z } from 'zod';

const ENTRY_SCHEMA = z.object({
  path: z.string().min(1, 'manifest entry path must be non-empty'),
  map: z.record(z.string().min(1), z.string().min(1, 'manifest map values must be non-empty env var names')),
});

export const VAULT_SECRET_MANIFEST_SCHEMA = z.array(ENTRY_SCHEMA);

export type VaultSecretManifestEntry = z.infer<typeof ENTRY_SCHEMA>;
export type VaultSecretManifest = z.infer<typeof VAULT_SECRET_MANIFEST_SCHEMA>;

/**
 * Parse the raw `VAULT_SECRETS_MANIFEST` env var.
 *
 * Returns `[]` for `undefined`, empty, or whitespace-only values — this
 * lets operators flip Vault env-loading on/off without unsetting the var.
 *
 * Throws on malformed JSON or schema-failing structures (configuration
 * error → fail loud at boot).
 */
export function parseSecretManifest(raw: string | undefined): VaultSecretManifest {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`VAULT_SECRETS_MANIFEST is not valid JSON: ${reason}`);
  }

  const result = VAULT_SECRET_MANIFEST_SCHEMA.safeParse(parsed);
  if (!result.success) {
    throw new Error(`VAULT_SECRETS_MANIFEST has invalid structure: ${result.error.message}`);
  }
  return result.data;
}
