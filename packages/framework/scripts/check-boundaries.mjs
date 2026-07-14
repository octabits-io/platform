#!/usr/bin/env node
/**
 * Enforces the package's internal dependency tree. Run as part of `lint`.
 *
 * The package has two tiers under src/:
 *
 *   base modules  (result, ioc, logger, utils, config-schema, rbac, auth,
 *                  signing, vault, captcha, pii, drizzle, ical)
 *       → may import each other; must never import an app module or an
 *         app-tier vendor SDK
 *   app modules   (elysia, queue, storage, mail)
 *       → may import base modules; must never import each other, and each
 *         is confined to its own vendor SDKs
 *
 * This keeps every subpath export independently importable: pulling in
 * `@octabits-io/framework/mail` can never drag along pg-boss, the AWS SDK,
 * or Elysia.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const APP_MODULES = ['elysia', 'queue', 'storage', 'mail'];

// Vendor SDKs that belong to exactly one app module. '@scope' entries match the
// whole scope. Base-tier vendors (pg, drizzle-orm, jose, zod, altcha-lib,
// ical.js, @noble/*, …) are not listed — the optional-peer setup governs those.
const ELYSIA_VENDORS = ['elysia', 'elysia-mcp', 'elysia-rate-limit', '@modelcontextprotocol', '@sinclair/typebox'];
const QUEUE_VENDORS = ['pg-boss'];
const STORAGE_VENDORS = ['@aws-sdk'];
const MAIL_VENDORS = ['nodemailer', 'node-mailjet', 'wretch'];

/** module → { internal: allowed other modules ('' = base tier), externals: forbidden packages } */
const RULES = {
  elysia: { internal: [''], externals: [...QUEUE_VENDORS, ...STORAGE_VENDORS, ...MAIL_VENDORS] },
  queue: { internal: [''], externals: [...ELYSIA_VENDORS, ...STORAGE_VENDORS, ...MAIL_VENDORS] },
  storage: { internal: [''], externals: [...ELYSIA_VENDORS, ...QUEUE_VENDORS, ...MAIL_VENDORS] },
  mail: { internal: [''], externals: [...ELYSIA_VENDORS, ...QUEUE_VENDORS, ...STORAGE_VENDORS] },
  // base tier: all of src/ outside the four app modules
  '': { internal: [], externals: [...ELYSIA_VENDORS, ...QUEUE_VENDORS, ...STORAGE_VENDORS, ...MAIL_VENDORS] },
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** module a file belongs to (first path segment under src/ if an app module, else '' = base) */
function moduleOf(absPath) {
  const rel = relative(SRC, absPath);
  const seg = rel.split(/[\\/]/);
  return APP_MODULES.includes(seg[0]) ? seg[0] : '';
}

/** package name of a bare import specifier ('@aws-sdk/client-s3' → '@aws-sdk/client-s3', 'pg-boss/x' → 'pg-boss') */
function pkgName(spec) {
  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/');
    return name ? `${scope}/${name}` : scope;
  }
  return spec.split('/')[0];
}

/** does forbidden-list entry f match package name? bare '@scope' entries match the whole scope */
function matches(f, name) {
  return f.startsWith('@') && !f.includes('/') ? name.startsWith(`${f}/`) || name === f : name === f;
}

const IMPORT_RE = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations = [];

for (const file of walk(SRC)) {
  const mod = moduleOf(file);
  const rule = RULES[mod];
  const src = readFileSync(file, 'utf8');
  const rel = relative(SRC, file);

  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;

    if (spec.startsWith('.')) {
      const targetMod = moduleOf(resolve(dirname(file), spec));
      if (targetMod === mod) continue;
      if (!rule.internal.includes(targetMod)) {
        violations.push(`${rel}: '${mod || '(base)'}' may not import module '${targetMod || '(base)'}'  →  ${spec}`);
      }
    } else if (!spec.startsWith('node:')) {
      const name = pkgName(spec);
      const forbidden = rule.externals.find((f) => matches(f, name));
      if (forbidden) {
        violations.push(`${rel}: '${mod || '(base)'}' may not depend on external '${name}'  →  ${spec}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error('✗ framework dependency-boundary violations:\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n${violations.length} violation(s). See scripts/check-boundaries.mjs for the rules.`);
  process.exit(1);
}

console.log('✓ framework dependency boundaries OK');
