/**
 * @octabits-io/schema — generic multi-tenant Drizzle schema primitives.
 *
 * Provides the three base tables every multi-tenant SaaS needs before its
 * domain tables:
 *
 *   - `tenant`               — the tenant root (generic columns only)
 *   - `tenantEncryptionKey`  — per-tenant PII encryption material (Age + blind index)
 *   - `tenantConfig`         — generic per-tenant key/value config
 *
 * Two consumption styles are exported:
 *
 *  1. **Ready-built tables + relations** (`tenant`, `tenantEncryptionKey`,
 *     `tenantConfig`, `tenantRelations`, …). Use these directly if the base
 *     shape is all you need.
 *
 *  2. **Reusable column-sets** (`baseTenantColumns`,
 *     `tenantEncryptionKeyColumns`, `tenantConfigColumns`). Spread these into
 *     your own `pgTable(...)` to *extend* the base with domain columns while
 *     keeping the generic core in one place — this is the documented Drizzle
 *     "reuse common column definitions" pattern:
 *
 *     ```ts
 *     import { pgTable, text, integer } from 'drizzle-orm/pg-core';
 *     import { baseTenantColumns } from '@octabits-io/schema';
 *
 *     export const tenant = pgTable('tenant', {
 *       ...baseTenantColumns,              // id, name, isDisabled, createdAt
 *       orgId: text('org_id').notNull(),   // your domain columns
 *       operatorMode: text('operator_mode').notNull().default('direct'),
 *     });
 *     ```
 *
 * Only `drizzle-orm/pg-core` primitives are used — no framework or app imports.
 */
import { relations } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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

// ---------------------------------------------------------------------------
// Column-sets (extension mechanism)
// ---------------------------------------------------------------------------

/**
 * The truly generic `tenant` columns. Spread into a `pgTable('tenant', {...})`
 * to add domain-specific columns while reusing this base.
 *
 * Column-compatible with a hand-written table whose `id` is a text primary key,
 * `name` a required text, `is_disabled` a boolean defaulting to false, and
 * `created_at` a `timestamptz` defaulting to now().
 */
export const baseTenantColumns = {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  isDisabled: boolean("is_disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
};

/**
 * Generic `tenant_encryption_key` columns — per-tenant PII encryption material.
 * `tenantId` is unique (one active key row per tenant). The foreign key to the
 * tenant table is intentionally *not* part of the column-set (it depends on the
 * concrete tenant table); add it in the table's constraints callback.
 */
export const tenantEncryptionKeyColumns = {
  id: bigserial({ mode: "number" }).primaryKey().notNull(),
  tenantId: text("tenant_id").notNull().unique(),
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
 * Generic `tenant_config` columns — a per-tenant key/value store. The composite
 * primary key `(tenantId, key)` and the foreign key to the tenant table are
 * table-level constraints and must be declared in the table's constraints
 * callback (they depend on the concrete tenant table).
 */
export const tenantConfigColumns = {
  tenantId: text("tenant_id").notNull(),
  key: text().notNull(),
  value: jsonb().notNull(),
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

// ---------------------------------------------------------------------------
// Ready-built base tables
// ---------------------------------------------------------------------------

/** Base `tenant` table built from {@link baseTenantColumns}. */
export const tenant = pgTable("tenant", {
  ...baseTenantColumns,
});

/** Base `tenant_encryption_key` table with FK + index to {@link tenant}. */
export const tenantEncryptionKey = pgTable(
  "tenant_encryption_key",
  {
    ...tenantEncryptionKeyColumns,
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
      name: "tenant_encryption_key_tenant_id_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    index("tenant_encryption_key_tenant_id_idx").on(table.tenantId),
  ],
);

/** Base `tenant_config` table with composite PK + FK to {@link tenant}. */
export const tenantConfig = pgTable(
  "tenant_config",
  {
    ...tenantConfigColumns,
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
      name: "tenant_config_tenant_id_fk",
    }),
    primaryKey({ columns: [table.tenantId, table.key], name: "tenant_config_pk" }),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const tenantRelations = relations(tenant, ({ one, many }) => ({
  encryptionKey: one(tenantEncryptionKey, {
    fields: [tenant.id],
    references: [tenantEncryptionKey.tenantId],
  }),
  configs: many(tenantConfig),
}));

export const tenantEncryptionKeyRelations = relations(
  tenantEncryptionKey,
  ({ one }) => ({
    tenant: one(tenant, {
      fields: [tenantEncryptionKey.tenantId],
      references: [tenant.id],
    }),
  }),
);

export const tenantConfigRelations = relations(tenantConfig, ({ one }) => ({
  tenant: one(tenant, {
    fields: [tenantConfig.tenantId],
    references: [tenant.id],
  }),
}));
