#!/usr/bin/env node
/**
 * Enforces the one boundary this package has: `src/ai/core` is framework-free.
 * Run as part of `lint`.
 *
 *   src/ai/core/**  → may import only its own files. No `vue`, no `@vue/*`,
 *                     no `vue-i18n`, no `@nuxt/ui`, no other kit module, no
 *                     vendor at all. (`vitest` in *.test.ts is the one exception.)
 *
 * The core is the AI-UX state machines; the composables around it are Vue
 * bindings. Keeping the core importable without Vue is what makes a second
 * framework adapter a thin file rather than a rewrite — and it is the claim
 * the strategy memo makes about this layer, so it had better be checked.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CORE = join(SRC, 'ai', 'core');
const TEST_ONLY_VENDORS = new Set(['vitest']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations = [];

for (const file of walk(CORE)) {
  const rel = relative(SRC, file);
  const isTest = rel.endsWith('.test.ts');
  const src = readFileSync(file, 'utf8');

  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;

    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      if (relative(CORE, target).startsWith('..')) {
        violations.push(`${rel}: core may not import outside src/ai/core  →  ${spec}`);
      }
    } else if (!spec.startsWith('node:')) {
      if (isTest && TEST_ONLY_VENDORS.has(spec.split('/')[0])) continue;
      violations.push(`${rel}: core may not depend on any package  →  ${spec}`);
    }
  }
}

if (violations.length > 0) {
  console.error('✗ nuxt-ui-kit boundary violations:\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n${violations.length} violation(s). See scripts/check-boundaries.mjs for the rule.`);
  process.exit(1);
}

console.log('✓ nuxt-ui-kit boundaries OK (src/ai/core is framework-free)');
