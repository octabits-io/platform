import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { kitMessagesEn } from './index.ts';

/** Every leaf value, keyed by its dotted path. */
function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return { [prefix]: value };
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>(
    (acc, [key, child]) => Object.assign(acc, flatten(child, prefix ? `${prefix}.${key}` : key)),
    {},
  );
}

describe('kit message fragments', () => {
  it('no empty values, at any depth', () => {
    for (const [path, value] of Object.entries(flatten(kitMessagesEn))) {
      expect(value, path).toBeTruthy();
    }
  });

  /**
   * The fragment claims to be "the reference for the full key set", and a
   * consumer that merges it should never see a raw key path render. That claim
   * was false until 2026-08-31 — the components' `dateInput.*`, `dateRange.*`,
   * `flexPeriod.*`, `period.*` and `ai.review.*` keys were missing — so it is
   * now checked against the source rather than maintained by hand.
   */
  it('covers every key the kit itself asks for', () => {
    const provided = new Set(Object.keys(flatten(kitMessagesEn)));
    const sources = [
      ...readdirSync(new URL('../components', import.meta.url), { withFileTypes: true }),
      ...readdirSync(new URL('../composables', import.meta.url), { withFileTypes: true }),
    ]
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.test.ts'))
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));

    const used = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/\bte?\('([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)'/g)) {
        used.add(match[1]!);
      }
    }
    // Sanity: the scan must actually find keys, or this test proves nothing.
    expect(used.size).toBeGreaterThan(20);

    const missing = [...used].filter((key) => !provided.has(key)).sort();
    expect(missing).toEqual([]);
  });
});
