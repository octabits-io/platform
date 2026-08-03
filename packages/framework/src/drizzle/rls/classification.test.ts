/**
 * Drift tripwire for the RLS scoped-db proxy: enumerates the ACTUAL surface of
 * the installed drizzle-orm's node-postgres db (augmented by `../factory`) and
 * asserts every member is classified exactly once — wrapped by the proxy or
 * allowlisted as passthrough. A drizzle upgrade that adds, renames, or removes
 * an entry point fails HERE at `pnpm test:unit`, before it can ever run
 * GUC-less in an app. Runtime companion: the proxy itself is fail-closed and
 * throws on unclassified members.
 */
import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { createDrizzle } from '../factory/index.ts';
import {
  QUERY_BUILDER_METHODS,
  QUERY_NAMESPACE_METHODS,
  SCOPED_DB_PASSTHROUGH_PROPS,
} from './index.ts';

/** Props handled by dedicated branches in createScopedDb's get trap. */
const WRAPPED_SPECIALS = new Set(['transaction', 'execute', 'query', '$with']);

const marker = pgTable('marker', { id: text('id').primaryKey() });

// A real augmented instance over a never-connected Pool — pg connects lazily,
// so constructing this is side-effect free.
const db = createDrizzle({ marker }, { pool: new Pool() });

/**
 * All own + inherited property names up to (excluding) Object.prototype,
 * minus Object.prototype's own members (constructor, toString, …) — the same
 * exemption the proxy applies at runtime.
 */
function collectProps(obj: object): Set<string> {
  const names = new Set<string>();
  let cur: object | null = obj;
  while (cur && cur !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cur)) {
      if (!(name in Object.prototype)) names.add(name);
    }
    cur = Object.getPrototypeOf(cur);
  }
  return names;
}

describe('scoped-db classification contract (drizzle upgrade tripwire)', () => {
  it('classifies every member of the installed Drizzle db', () => {
    const unclassified = [...collectProps(db)].filter(
      (p) =>
        !QUERY_BUILDER_METHODS.has(p) &&
        !WRAPPED_SPECIALS.has(p) &&
        !SCOPED_DB_PASSTHROUGH_PROPS.has(p),
    );
    // A member listed here is NEW Drizzle surface: decide whether it executes
    // SQL (→ QUERY_BUILDER_METHODS or a dedicated wrap) or cannot
    // (→ SCOPED_DB_PASSTHROUGH_PROPS). Do not add it blindly to passthrough.
    expect(unclassified).toEqual([]);
  });

  it('classifies every member exactly once (no overlapping buckets)', () => {
    for (const p of QUERY_BUILDER_METHODS) {
      expect(WRAPPED_SPECIALS.has(p), `'${p}' in two buckets`).toBe(false);
      expect(SCOPED_DB_PASSTHROUGH_PROPS.has(p), `'${p}' in two buckets`).toBe(false);
    }
    for (const p of WRAPPED_SPECIALS) {
      expect(SCOPED_DB_PASSTHROUGH_PROPS.has(p), `'${p}' in two buckets`).toBe(false);
    }
  });

  it('has no stale classifications (renamed/removed drizzle members)', () => {
    const props = collectProps(db);
    for (const p of [
      ...QUERY_BUILDER_METHODS,
      ...WRAPPED_SPECIALS,
      ...SCOPED_DB_PASSTHROUGH_PROPS,
    ]) {
      expect(props.has(p), `stale classification: '${p}' no longer on the db`).toBe(true);
    }
  });

  it('classifies every function on a relational table-query namespace', () => {
    const tableQuery = db.query.marker as unknown as Record<string, unknown>;
    const fnProps = [...collectProps(tableQuery as object)].filter(
      (p) => typeof tableQuery[p] === 'function',
    );
    const unclassified = fnProps.filter((p) => !QUERY_NAMESPACE_METHODS.has(p));
    expect(unclassified).toEqual([]);
    for (const p of QUERY_NAMESPACE_METHODS) {
      expect(fnProps.includes(p), `stale classification: '${p}'`).toBe(true);
    }
  });
});
