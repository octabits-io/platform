/**
 * @octabits-io/foundation/drizzle/scope — generic Drizzle schema primitives for a
 * **scope-owner** root table plus per-scope encryption keys and per-scope
 * config.
 *
 * A "scope" is whatever partitions the consumer's app — a tenant, workspace,
 * organization, project, or nothing at all in a single-tenant deployment. This
 * module ships reusable **column-sets** for three common base tables:
 *
 *   - `baseScopeColumns`      — the scope-owner root (generic columns only)
 *   - `encryptionKeyColumns`  — per-scope PII encryption material (Age + blind index)
 *   - `scopedConfigColumns`   — generic per-scope key/value config
 *
 * The scope-reference column itself (its name, type, FK, uniqueness) is the
 * consumer's to declare — so a single-tenant consumer can simply omit it where
 * a scope column is not needed.
 *
 * Spread a column-set into your own `pgTable(...)` to *extend* the base with
 * domain columns while keeping the generic core in one place — this is the
 * documented Drizzle "reuse common column definitions" pattern:
 *
 * ```ts
 * import { pgTable, text, integer } from 'drizzle-orm/pg-core';
 * import { baseScopeColumns } from '@octabits-io/foundation/drizzle/scope';
 *
 * // The scope-owner root table (a tenant, workspace, organization, project…):
 * export const workspace = pgTable('workspace', {
 *   ...baseScopeColumns,               // id, name, isDisabled, createdAt
 *   region: text('region').notNull(),  // your domain columns
 *   operatorMode: text('operator_mode').notNull().default('direct'),
 * });
 * ```
 *
 * The tables themselves (and their FKs, indexes, and relations) are yours to
 * declare — constraints depend on your concrete scope-owner table, so this
 * module deliberately ships no `pgTable` instances that could couple a
 * consumer's migrations to a library schema.
 *
 * Only `drizzle-orm/pg-core` primitives are used — no framework or app imports.
 */
import {
  bigserial,
  boolean,
  customType,
  integer,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Custom `bytea` column type — maps a PostgreSQL `bytea` to a Node.js `Buffer`
 * on both the driver and application side. Used for the encrypted key material.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Buffer): Buffer {
    return value;
  },
  fromDriver(value: Buffer): Buffer {
    return value;
  },
});

/**
 * Custom `jsonb` column type that trusts the driver's parsing instead of
 * re-parsing.
 *
 * Drizzle's stock `jsonb()` defensively runs `JSON.parse` on any *string* it
 * receives from the driver (a fallback for drivers that return jsonb as raw
 * text). `pg` (node-postgres) already parses jsonb, so a stored top-level JSON
 * **string whose content is itself valid JSON** gets parsed a second time and
 * silently changes type on read: `"73235"` → `73235` (number), `"true"` →
 * `true` (boolean), `"null"` → `null`. Key/value config is exactly the kind
 * of data that hits this (postal codes, numeric-looking free text), breaking
 * the write→read round-trip.
 *
 * Writes serialize identically to stock (`JSON.stringify`); reads pass the
 * driver value through untouched. Requires a driver that parses json/jsonb
 * result columns itself (node-postgres does by default).
 */
export const jsonbSafe = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value: unknown): string {
    return JSON.stringify(value);
  },
  fromDriver(value: unknown): unknown {
    return value;
  },
});

// ---------------------------------------------------------------------------
// Column-sets (extension mechanism)
// ---------------------------------------------------------------------------

/**
 * The truly generic scope-owner root columns. Spread into a
 * `pgTable('workspace', {...})` (or `'tenant'`, `'organization'`, … — whatever
 * you call the root that owns a scope) to add domain-specific columns while
 * reusing this base.
 *
 * Column-compatible with a hand-written table whose `id` is a text primary key,
 * `name` a required text, `is_disabled` a boolean defaulting to false, and
 * `created_at` a `timestamptz` defaulting to now().
 */
export const baseScopeColumns = {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  isDisabled: boolean("is_disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
};

/**
 * Generic per-scope encryption-key columns — PII encryption material for one
 * scope. The **scope-reference column is intentionally not part of the set**:
 * declare it yourself so you own its name, type, FK, and uniqueness. Add a
 * unique scope column (one active key row per scope) plus the foreign key to
 * your scope-owner table in the table's definition:
 *
 * ```ts
 * import { pgTable, text, foreignKey } from 'drizzle-orm/pg-core';
 * import { encryptionKeyColumns } from '@octabits-io/foundation/drizzle/scope';
 *
 * export const encryptionKey = pgTable(
 *   'encryption_key',
 *   {
 *     ...encryptionKeyColumns,
 *     tenantId: text('tenant_id').notNull().unique(), // your scope column
 *   },
 *   (t) => [
 *     foreignKey({ columns: [t.tenantId], foreignColumns: [tenant.id], name: 'encryption_key_tenant_id_fk' }),
 *   ],
 * );
 * ```
 *
 * The scope column **must be unique** (one active key row per scope):
 * `@octabits-io/foundation/pii`'s `createScopedKeyService` relies on that uniqueness to
 * resolve exactly one key row per scope, and the lost-race →
 * `scoped_key_store_conflict` signal in
 * [`@octabits-io/foundation/drizzle/scoped-key-store`](./scoped-key-store) — the
 * Drizzle adapter behind pii's `ScopedKeyStore` seam — relies on the resulting
 * unique-violation (SQLSTATE 23505).
 *
 * **Pairs with `@octabits-io/foundation/pii`**: the column shapes (Age recipient,
 * master-key-encrypted Age identity, blind-index HMAC key) are specific to that
 * package's encryption scheme. If your app does not use `@octabits-io/foundation/pii`,
 * skip this column-set entirely — the base scope / scoped-config column-sets do
 * not depend on it.
 */
export const encryptionKeyColumns = {
  id: bigserial({ mode: "number" }).primaryKey().notNull(),
  /** Age public key (plaintext — safe to store). */
  recipient: text().notNull(),
  /** Age private key, encrypted with the master key. */
  identityEncrypted: bytea("identity_encrypted").notNull(),
  /** Blind-index HMAC key, encrypted with the master key. */
  blindIndexKeyEncrypted: bytea("blind_index_key_encrypted").notNull(),
  /** Version marker for future key rotation. */
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "string" }),
};

/**
 * Generic scoped key/value config columns. The **scope-reference column is not
 * part of the set** — declare it yourself, then make the composite primary key
 * `(scopeColumn, key)` (and any FK to your scope-owner table) in the table's
 * constraints callback:
 *
 * ```ts
 * import { pgTable, text, primaryKey } from 'drizzle-orm/pg-core';
 * import { scopedConfigColumns } from '@octabits-io/foundation/drizzle/scope';
 *
 * export const config = pgTable(
 *   'config',
 *   {
 *     ...scopedConfigColumns,
 *     tenantId: text('tenant_id').notNull(), // your scope column
 *   },
 *   (t) => [primaryKey({ columns: [t.tenantId, t.key], name: 'config_pk' })],
 * );
 * ```
 *
 * A single-tenant consumer can omit the scope column entirely and make `(key)`
 * the primary key.
 */
export const scopedConfigColumns = {
  key: text().notNull(),
  value: jsonbSafe().notNull(),
  encrypted: boolean().notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
};
