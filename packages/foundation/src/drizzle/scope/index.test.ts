import { getTableColumns } from "drizzle-orm";
import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  baseScopeColumns,
  bytea,
  encryptionKeyColumns,
  jsonbSafe,
  scopedConfigColumns,
} from "./index";

/** Map a Drizzle table's columns to `{ tsKey: sqlName }` for assertions. */
function columnNameMap(table: Parameters<typeof getTableColumns>[0]) {
  const cols = getTableColumns(table);
  return Object.fromEntries(
    Object.entries(cols).map(([tsKey, col]) => [tsKey, (col as { name: string }).name]),
  );
}

describe("baseScopeColumns", () => {
  const scopeOwner = pgTable("workspace", { ...baseScopeColumns });

  it("exposes only the generic scope-owner columns", () => {
    expect(Object.keys(baseScopeColumns).sort()).toEqual(
      ["createdAt", "id", "isDisabled", "name"].sort(),
    );
  });

  it("does NOT leak domain-specific columns", () => {
    for (const leaked of ["orgId", "operatorMode", "aiMaxWorkflowsPerDay", "disabledReason"]) {
      expect(baseScopeColumns).not.toHaveProperty(leaked);
    }
  });

  it("maps to the expected SQL columns", () => {
    expect(columnNameMap(scopeOwner)).toEqual({
      id: "id",
      name: "name",
      isDisabled: "is_disabled",
      createdAt: "created_at",
    });
  });

  it("has id as the primary key", () => {
    const cols = getTableColumns(scopeOwner);
    expect(cols.id.primary).toBe(true);
    expect(cols.name.notNull).toBe(true);
  });
});

describe("encryptionKeyColumns", () => {
  // The scope column is the consumer's to declare — add one to build the table.
  const encryptionKey = pgTable("encryption_key", {
    ...encryptionKeyColumns,
    tenantId: text("tenant_id").notNull().unique(),
  });

  it("does NOT ship a scope-reference column (consumer declares it)", () => {
    expect(encryptionKeyColumns).not.toHaveProperty("tenantId");
  });

  it("maps to the expected SQL columns", () => {
    expect(columnNameMap(encryptionKey)).toEqual({
      id: "id",
      tenantId: "tenant_id",
      recipient: "recipient",
      identityEncrypted: "identity_encrypted",
      blindIndexKeyEncrypted: "blind_index_key_encrypted",
      keyVersion: "key_version",
      createdAt: "created_at",
      rotatedAt: "rotated_at",
    });
  });

  it("stores encrypted material as bytea", () => {
    const cols = getTableColumns(encryptionKey);
    expect(cols.identityEncrypted.getSQLType()).toBe("bytea");
    expect(cols.blindIndexKeyEncrypted.getSQLType()).toBe("bytea");
  });

  it("lets the consumer make the scope column unique", () => {
    expect(getTableColumns(encryptionKey).tenantId.isUnique).toBe(true);
  });
});

describe("scopedConfigColumns", () => {
  // The scope column is the consumer's to declare — add one to build the table.
  const config = pgTable("config", {
    ...scopedConfigColumns,
    tenantId: text("tenant_id").notNull(),
  });

  it("does NOT ship a scope-reference column (consumer declares it)", () => {
    expect(scopedConfigColumns).not.toHaveProperty("tenantId");
  });

  it("maps to the expected SQL columns", () => {
    expect(columnNameMap(config)).toEqual({
      key: "key",
      value: "value",
      encrypted: "encrypted",
      createdAt: "created_at",
      updatedAt: "updated_at",
      createdBy: "created_by",
      updatedBy: "updated_by",
      tenantId: "tenant_id",
    });
  });

  it("stores value as jsonb", () => {
    expect(getTableColumns(config).value.getSQLType()).toBe("jsonb");
  });

  it("round-trips JSON-string values without double-parsing (jsonbSafe)", () => {
    // node-postgres parses jsonb itself, so the driver hands the column a
    // JS string "73235" for the stored JSON string "73235". Stock jsonb()
    // would JSON.parse it AGAIN → number 73235. Regression for the
    // legal_address_postal_code config drop.
    const value = getTableColumns(config).value;
    expect(value.mapFromDriverValue("73235")).toBe("73235");
    expect(value.mapFromDriverValue("true")).toBe("true");
    expect(value.mapFromDriverValue("null")).toBe("null");
    // Non-string driver values (objects, numbers, booleans) pass through.
    expect(value.mapFromDriverValue({ a: 1 })).toEqual({ a: 1 });
    expect(value.mapFromDriverValue(42)).toBe(42);
  });

  it("serializes writes identically to stock jsonb (JSON.stringify)", () => {
    const value = getTableColumns(config).value;
    expect(value.mapToDriverValue("73235")).toBe('"73235"');
    expect(value.mapToDriverValue({ a: 1 })).toBe('{"a":1}');
    expect(value.mapToDriverValue(42)).toBe("42");
  });
});

describe("bytea custom type", () => {
  it("resolves to the bytea SQL type", () => {
    const probe = pgTable("probe", { blob: bytea("blob") });
    expect(getTableColumns(probe).blob.getSQLType()).toBe("bytea");
  });
});

describe("jsonbSafe custom type", () => {
  const probe = pgTable("probe", { body: jsonbSafe("body") });

  it("resolves to the jsonb SQL type (zero-DDL swap for stock jsonb)", () => {
    expect(getTableColumns(probe).body.getSQLType()).toBe("jsonb");
  });

  it("trusts driver-parsed values instead of re-parsing strings", () => {
    const body = getTableColumns(probe).body;
    expect(body.mapFromDriverValue("ok")).toBe("ok");
    expect(body.mapFromDriverValue("123")).toBe("123");
    expect(body.mapFromDriverValue([1, 2])).toEqual([1, 2]);
  });
});

describe("extension mechanism (spread column-set)", () => {
  it("lets a consumer add domain columns while reusing the base", () => {
    const extendedScope = pgTable("workspace", {
      ...baseScopeColumns,
      orgId: text("org_id").notNull(),
      operatorMode: text("operator_mode").notNull().default("direct"),
      aiMaxWorkflowsPerDay: integer("ai_max_workflows_per_day"),
      disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "string" }),
      disabledReason: text("disabled_reason"),
    });

    const names = columnNameMap(extendedScope);
    // Base columns survive the spread…
    expect(names.id).toBe("id");
    expect(names.name).toBe("name");
    expect(names.isDisabled).toBe("is_disabled");
    expect(names.createdAt).toBe("created_at");
    // …alongside the domain columns.
    expect(names.orgId).toBe("org_id");
    expect(names.operatorMode).toBe("operator_mode");
    expect(names.aiMaxWorkflowsPerDay).toBe("ai_max_workflows_per_day");
    expect(names.disabledReason).toBe("disabled_reason");

    // The column-set is unaffected by a consumer's extension.
    expect(baseScopeColumns).not.toHaveProperty("orgId");
  });
});
