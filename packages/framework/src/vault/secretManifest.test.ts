/**
 * `VAULT_SECRETS_MANIFEST` parsing — the first thing that runs at boot, before
 * config, before the logger is configured. Its whole contract is the split
 * between "no manifest" (start normally) and "broken manifest" (fail loudly):
 * a malformed manifest that parsed to `[]` would boot a process with none of
 * its secrets and no indication why.
 */
import { describe, expect, it } from 'vitest';
import { parseSecretManifest } from './secretManifest.ts';

describe('parseSecretManifest', () => {
  it('parses a manifest of path → env-var bindings', () => {
    const raw = JSON.stringify([
      { path: 'secret/data/app/db', map: { url: 'DATABASE_URL' } },
      { path: 'secret/data/app/api', map: { key: 'STRIPE_SECRET_KEY', alt: 'STRIPE_ALT' } },
    ]);

    expect(parseSecretManifest(raw)).toEqual([
      { path: 'secret/data/app/db', map: { url: 'DATABASE_URL' } },
      { path: 'secret/data/app/api', map: { key: 'STRIPE_SECRET_KEY', alt: 'STRIPE_ALT' } },
    ]);
  });

  it('treats unset, empty and whitespace-only as "no manifest"', () => {
    // So an operator can disable Vault loading by blanking the var rather than
    // unsetting it — the two must behave identically.
    expect(parseSecretManifest(undefined)).toEqual([]);
    expect(parseSecretManifest('')).toEqual([]);
    expect(parseSecretManifest('   \n\t ')).toEqual([]);
  });

  it('accepts an explicitly empty list', () => {
    expect(parseSecretManifest('[]')).toEqual([]);
  });

  it('throws on malformed JSON, naming the variable', () => {
    expect(() => parseSecretManifest('{not json')).toThrow(/VAULT_SECRETS_MANIFEST is not valid JSON/);
  });

  it('throws on a structurally invalid manifest rather than dropping entries', () => {
    const cases = [
      '{"path":"secret/data/app"}', // object, not a list
      '[{"map":{"a":"A"}}]', // no path
      '[{"path":"","map":{"a":"A"}}]', // empty path
      '[{"path":"secret/data/app","map":{"a":""}}]', // empty env var name
      '[{"path":"secret/data/app"}]', // no map
    ];

    for (const raw of cases) {
      expect(() => parseSecretManifest(raw)).toThrow(/invalid structure/);
    }
  });
});
