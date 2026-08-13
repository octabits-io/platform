#!/usr/bin/env node
/**
 * Enforces the package's internal dependency tree. Run as part of `lint`.
 *
 * The package has two tiers under src/:
 *
 *   base modules  (result, ioc, logger, utils, config-schema, rbac, auth,
 *                  signing, vault, captcha, pii, drizzle, ical, events, server)
 *       → may import each other; must never import an app module or an
 *         app-tier vendor SDK
 *   app modules   (hono, queue, storage, mail, zitadel)
 *       → may import base modules; must never import each other, and each
 *         is confined to its own vendor SDKs
 *
 * This keeps every subpath export independently importable: pulling in
 * `@octabits-io/framework/mail` can never drag along pg-boss, the AWS SDK,
 * or Hono.
 *
 * Elysia was removed in favour of `./hono`; its vendors are on a package-wide
 * ban list (BANNED_VENDORS) so the glue layer cannot creep back in.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const APP_MODULES = ['hono', 'queue', 'storage', 'mail', 'zitadel'];

// Vendor SDKs that belong to exactly one app module. '@scope' entries match the
// whole scope. Base-tier vendors (pg, drizzle-orm, jose, zod, altcha-lib,
// ical.js, @noble/*, …) are not listed — the optional-peer setup governs those.
// '@modelcontextprotocol' and 'octaflow' are used by the HTTP glue
// module but confined per-file (see SINGLE_FILE_VENDORS): only the
// `mcp.ts` / `flow.ts` factories may touch them (optional peers).
//
// Elysia's vendors are banned everywhere, not owned by a module: the `./elysia`
// glue was deleted once `./hono` reached parity, and `@sinclair/typebox` was
// only ever a hard dep because Elysia's instance generics leaked it into the
// emitted .d.ts.
const BANNED_VENDORS = ['elysia', 'elysia-mcp', 'elysia-rate-limit', '@elysiajs', '@sinclair/typebox'];
const HONO_VENDORS =['hono', '@hono/zod-validator', '@hono/mcp', 'hono-openapi', '@hono/standard-validator', '@standard-community/standard-json', '@standard-community/standard-openapi'];
const GLUE_SHARED_VENDORS = ['@modelcontextprotocol', 'octaflow'];
const QUEUE_VENDORS = ['pg-boss'];
const STORAGE_VENDORS = ['@aws-sdk'];
const MAIL_VENDORS = ['nodemailer', 'node-mailjet'];
// wretch is shared by exactly two app modules (mail's Brevo provider and the
// zitadel client) — still forbidden for every other module.
const HTTP_VENDORS = ['wretch'];

/** module → { internal: allowed other modules ('' = base tier), externals: forbidden packages } */
const RULES = {
  hono: { internal: [''], externals: [...BANNED_VENDORS, ...QUEUE_VENDORS, ...STORAGE_VENDORS, ...MAIL_VENDORS, ...HTTP_VENDORS] },
  queue: { internal: [''], externals: [...BANNED_VENDORS, ...HONO_VENDORS, ...GLUE_SHARED_VENDORS, ...STORAGE_VENDORS, ...MAIL_VENDORS, ...HTTP_VENDORS] },
  storage: { internal: [''], externals: [...BANNED_VENDORS, ...HONO_VENDORS, ...GLUE_SHARED_VENDORS, ...QUEUE_VENDORS, ...MAIL_VENDORS, ...HTTP_VENDORS] },
  mail: { internal: [''], externals: [...BANNED_VENDORS, ...HONO_VENDORS, ...GLUE_SHARED_VENDORS, ...QUEUE_VENDORS, ...STORAGE_VENDORS] },
  zitadel: { internal: [''], externals: [...BANNED_VENDORS, ...HONO_VENDORS, ...GLUE_SHARED_VENDORS, ...QUEUE_VENDORS, ...STORAGE_VENDORS, ...MAIL_VENDORS] },
  // base tier: all of src/ outside the app modules
  '': { internal: [], externals: [...BANNED_VENDORS, ...HONO_VENDORS, ...GLUE_SHARED_VENDORS, ...QUEUE_VENDORS, ...STORAGE_VENDORS, ...MAIL_VENDORS, ...HTTP_VENDORS] },
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

// ---------------------------------------------------------------------------
// Per-file rules inside the HTTP glue module (src/hono) — the confinement
// contract:
//
//   1. Vendor plugins are confined to single files: `@hono/mcp` may only be
//      imported by hono/mcp.ts, `hono-openapi` only by hono/openapi.ts, and
//      the MCP SDK / `octaflow` only by hono's mcp.ts / flow.ts.
//   2. Every non-test source file in a glue module must import its framework
//      vendor. A file that doesn't is framework-agnostic and belongs in
//      src/server (or another base module) — that's how config/run/swagger/
//      responses/testing drifted in before they were moved out. Pure re-export
//      compat files are allowlisted.
// ---------------------------------------------------------------------------
// vendor package → source files it is confined to (each file's *.test.ts fixtures included)
const SINGLE_FILE_VENDORS = {
  '@hono/mcp': ['hono/mcp.ts'],
  'hono-openapi': ['hono/openapi.ts'],
  '@modelcontextprotocol/sdk': ['hono/mcp.ts'],
  'octaflow': ['hono/flow.ts'],
};
// Compat re-export files: no framework-vendor import, allowed to stay for import-path stability.
const GLUE_REEXPORT_FILES = new Set(['hono/index.ts']);
// module → vendor list that counts as "imports its framework vendor"
const GLUE_VENDOR_TIERS = {
  hono: [...HONO_VENDORS, ...GLUE_SHARED_VENDORS],
};

const IMPORT_RE = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations = [];

for (const file of walk(SRC)) {
  const mod = moduleOf(file);
  const rule = RULES[mod];
  const src = readFileSync(file, 'utf8');
  const rel = relative(SRC, file);

  const glueVendorTier = GLUE_VENDOR_TIERS[mod];
  let importsGlueVendor = false;

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
      // Any vendor of the module's own tier counts as framework coupling
      // (hono/openapi.ts wraps hono-openapi without importing hono itself).
      if (glueVendorTier?.some((f) => matches(f, name))) importsGlueVendor = true;
      const forbidden = rule.externals.find((f) => matches(f, name));
      if (forbidden) {
        violations.push(`${rel}: '${mod || '(base)'}' may not depend on external '${name}'  →  ${spec}`);
      }
      const onlyIn = SINGLE_FILE_VENDORS[name];
      if (
        onlyIn
        && !onlyIn.includes(rel)
        && !(rel.endsWith('.test.ts') && onlyIn.some((f) => rel.startsWith(f.replace(/\.ts$/, ''))))
      ) {
        violations.push(`${rel}: '${name}' is confined to ${onlyIn.join(', ')}  →  ${spec}`);
      }
    }
  }

  // Misfiling guard: a glue-module source file that never imports its
  // framework vendor is framework-agnostic and belongs in a base module
  // (see src/server).
  const isTest = rel.endsWith('.test.ts');
  if (glueVendorTier && !isTest && !importsGlueVendor && !GLUE_REEXPORT_FILES.has(rel)) {
    violations.push(`${rel}: no '${mod}'-tier vendor import — framework-agnostic code belongs in src/server (or another base module), not src/${mod}`);
  }
}

if (violations.length > 0) {
  console.error('✗ framework dependency-boundary violations:\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n${violations.length} violation(s). See scripts/check-boundaries.mjs for the rules.`);
  process.exit(1);
}

console.log('✓ framework dependency boundaries OK');
