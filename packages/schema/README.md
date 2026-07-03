# @octabits-io/schema

Generic multi-tenant [Drizzle ORM](https://orm.drizzle.team) schema primitives —
the three base tables every multi-tenant SaaS needs before its domain tables:

| Table                  | Purpose                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `tenant`               | The tenant root — generic columns only (`id`, `name`, `isDisabled`, `createdAt`). |
| `tenantEncryptionKey`  | Per-tenant PII encryption material (Age recipient + encrypted identity + blind-index key). |
| `tenantConfig`         | Per-tenant `(tenantId, key) → jsonb value` config store.          |

Only `drizzle-orm/pg-core` primitives are used — no framework or app imports.
`drizzle-orm` is a peer dependency.

## Install

```bash
pnpm add @octabits-io/schema drizzle-orm
```

## Two ways to consume

### 1. Ready-built tables

If the generic shape is all you need, import the tables and relations directly:

```ts
import {
  tenant,
  tenantEncryptionKey,
  tenantConfig,
  tenantRelations,
  tenantEncryptionKeyRelations,
  tenantConfigRelations,
} from "@octabits-io/schema";
```

### 2. Extend the base with your own columns (recommended for real apps)

Each table also ships as a **column-set** you can spread into your own
`pgTable(...)`. This is the documented Drizzle
["reuse common column definitions"](https://orm.drizzle.team/docs/sql-schema-declaration#advanced)
pattern — the base columns stay in one place while you add domain columns:

```ts
import { pgTable, text, integer, timestamp, foreignKey } from "drizzle-orm/pg-core";
import { baseTenantColumns, tenantConfigColumns } from "@octabits-io/schema";

// Extend `tenant` with your domain columns:
export const tenant = pgTable("tenant", {
  ...baseTenantColumns, // id, name, isDisabled, createdAt
  orgId: text("org_id").notNull(),
  operatorMode: text("operator_mode").notNull().default("direct"),
  aiMaxWorkflowsPerDay: integer("ai_max_workflows_per_day"),
  disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "string" }),
  disabledReason: text("disabled_reason"),
});

// The config / encryption-key column-sets omit the FK + composite PK, since
// those depend on *your* tenant table — add them in the constraints callback:
export const tenantConfig = pgTable(
  "tenant_config",
  { ...tenantConfigColumns },
  (t) => [
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenant.id], name: "tenant_config_tenant_id_fk" }),
  ],
);
```

## Exports

| Export | Kind |
| ------ | ---- |
| `bytea` | Custom `bytea ↔ Buffer` column type |
| `baseTenantColumns` | Column-set: `id`, `name`, `isDisabled`, `createdAt` |
| `tenantEncryptionKeyColumns` | Column-set for `tenant_encryption_key` |
| `tenantConfigColumns` | Column-set for `tenant_config` |
| `tenant`, `tenantEncryptionKey`, `tenantConfig` | Ready-built `pgTable`s |
| `tenantRelations`, `tenantEncryptionKeyRelations`, `tenantConfigRelations` | Drizzle relations |

## License

MIT
