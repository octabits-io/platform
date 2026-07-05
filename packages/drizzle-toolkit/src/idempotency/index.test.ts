import { describe, it, expect, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  foreignKey,
  index,
  PgDialect,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

/** Render a captured Drizzle SQL condition to its Postgres text. */
const dialect = new PgDialect();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderSql = (where: unknown) => dialect.sqlToQuery(where as any).sql;
import {
  createIdempotencyService,
  hashRequest,
  idempotencyKeyColumns,
  isValidIdempotencyKey,
  type IdempotencyDatabase,
} from "./index.ts";

// A concrete table built from the shipped column-set, mirroring a typical
// multi-tenant `idempotency_key` (composite PK + FK + expiry index).
const tenant = pgTable("tenant", { id: text().primaryKey().notNull() });
const idempotencyKey = pgTable(
  "idempotency_key",
  { ...idempotencyKeyColumns },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.key], name: "idempotency_key_pk" }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
      name: "idempotency_key_tenant_id_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    index("idempotency_key_expires_at_idx").on(table.expiresAt),
  ],
);

const dateProvider = { now: () => new Date("2026-01-01T00:00:00Z") };

/**
 * Mock db capturing the select-where SQL, the inserted values, and the
 * delete-where SQL. `selectRows` seeds what `begin()`'s lookup returns.
 */
function makeDb(selectRows: Array<Record<string, unknown>>, opts?: { insertThrows?: unknown }) {
  const selectWheres: unknown[] = [];
  const deleteWheres: unknown[] = [];
  const insertValues = vi.fn(async (v: unknown) => {
    if (opts?.insertThrows) throw opts.insertThrows;
    return undefined;
  });
  const db: IdempotencyDatabase = {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          selectWheres.push(w);
          return { limit: async () => selectRows };
        },
      }),
    }),
    insert: () => ({ values: insertValues }),
    delete: () => ({
      where: async (w: unknown) => {
        deleteWheres.push(w);
        return [];
      },
    }),
  };
  return { db, selectWheres, deleteWheres, insertValues };
}

const noopLogger = { warn: vi.fn(), debug: vi.fn() };

const HASH = hashRequest("POST", "/x", { foo: 1 });
const OTHER_HASH = hashRequest("POST", "/x", { foo: 2 });
const FUTURE = "2026-01-02T00:00:00Z"; // after dateProvider.now()
const PAST = "2025-12-31T00:00:00Z"; // before dateProvider.now()

describe("idempotencyKeyColumns", () => {
  it("matches the reference idempotency_key column set (ts key → sql name)", () => {
    const cols = getTableColumns(idempotencyKey);
    const map = Object.fromEntries(
      Object.entries(cols).map(([k, c]) => [k, (c as { name: string }).name]),
    );
    expect(map).toEqual({
      tenantId: "tenant_id",
      key: "key",
      requestHash: "request_hash",
      responseStatus: "response_status",
      responseBody: "response_body",
      createdAt: "created_at",
      expiresAt: "expires_at",
    });
  });
});

describe("hashRequest / isValidIdempotencyKey", () => {
  it("hashes stably and varies by path/body", () => {
    expect(hashRequest("POST", "/a", { x: 1 })).toBe(hashRequest("POST", "/a", { x: 1 }));
    expect(HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRequest("POST", "/a", {})).not.toBe(hashRequest("POST", "/b", {}));
    expect(HASH).not.toBe(OTHER_HASH);
  });

  it("accepts 1–255 printable ASCII, rejects empty/oversized/control chars", () => {
    expect(isValidIdempotencyKey("a")).toBe(true);
    expect(isValidIdempotencyKey("x".repeat(255))).toBe(true);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(256))).toBe(false);
    expect(isValidIdempotencyKey("has\nnewline")).toBe(false);
  });
});

describe("createIdempotencyService.begin", () => {
  it("fresh begin → commit inserts a scoped row with TTL expiry", async () => {
    const { db, insertValues } = makeDb([]);
    const service = createIdempotencyService({
      db,
      table: idempotencyKey,
      dateProvider,
      tenantId: "t1",
      logger: noopLogger,
    });

    const outcome = await service.begin({ key: "k", requestHash: HASH });
    expect(outcome.kind).toBe("fresh");
    if (outcome.kind !== "fresh") return;

    await outcome.commit(200, { ok: true, draftId: 42 });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        key: "k",
        requestHash: HASH,
        responseStatus: 200,
        responseBody: { ok: true, draftId: 42 },
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-02T00:00:00.000Z", // now + 24h default TTL
      }),
    );
  });

  it("cached replay when a live row's hash matches", async () => {
    const { db } = makeDb([
      { requestHash: HASH, responseStatus: 201, responseBody: { cached: true }, expiresAt: FUTURE },
    ]);
    const service = createIdempotencyService({ db, table: idempotencyKey, dateProvider, tenantId: "t1" });

    const outcome = await service.begin({ key: "k", requestHash: HASH });
    expect(outcome.kind).toBe("cached");
    if (outcome.kind !== "cached") return;
    expect(outcome.cached).toEqual({ status: 201, body: { cached: true } });
  });

  it("conflict when a live row's hash differs", async () => {
    const { db, insertValues } = makeDb([
      { requestHash: OTHER_HASH, responseStatus: 200, responseBody: {}, expiresAt: FUTURE },
    ]);
    const service = createIdempotencyService({ db, table: idempotencyKey, dateProvider, tenantId: "t1" });

    const outcome = await service.begin({ key: "k", requestHash: HASH });
    expect(outcome.kind).toBe("conflict");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("expired row is dropped and treated as fresh", async () => {
    const { db, deleteWheres } = makeDb([
      { requestHash: HASH, responseStatus: 200, responseBody: {}, expiresAt: PAST },
    ]);
    const service = createIdempotencyService({ db, table: idempotencyKey, dateProvider, tenantId: "t1" });

    const outcome = await service.begin({ key: "k", requestHash: HASH });
    expect(outcome.kind).toBe("fresh"); // even though hash matched, the row expired
    expect(deleteWheres).toHaveLength(1); // expired row deleted before fall-through
  });

  it("commit swallows a unique-violation race (logs warn, no throw)", async () => {
    const uniqueViolation = Object.assign(new Error("dup"), { cause: { code: "23505" } });
    const warn = vi.fn();
    const { db } = makeDb([], { insertThrows: uniqueViolation });
    const service = createIdempotencyService({
      db,
      table: idempotencyKey,
      dateProvider,
      tenantId: "t1",
      logger: { warn, debug: vi.fn() },
    });

    const outcome = await service.begin({ key: "k", requestHash: HASH });
    if (outcome.kind !== "fresh") throw new Error("expected fresh");
    await expect(outcome.commit(200, { ok: true })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Idempotency commit lost race", { key: "k", requestHash: HASH });
  });

  it("commit rethrows a non-unique db error", async () => {
    const fkViolation = Object.assign(new Error("fk"), { cause: { code: "23503" } });
    const { db } = makeDb([], { insertThrows: fkViolation });
    const service = createIdempotencyService({ db, table: idempotencyKey, dateProvider, tenantId: "t1" });

    const outcome = await service.begin({ key: "k", requestHash: HASH });
    if (outcome.kind !== "fresh") throw new Error("expected fresh");
    await expect(outcome.commit(200, {})).rejects.toThrow("fk");
  });
});

describe("tenant scoping toggle", () => {
  it("scopes select/insert by tenantId when provided", async () => {
    const { db, selectWheres, insertValues } = makeDb([]);
    const service = createIdempotencyService({ db, table: idempotencyKey, dateProvider, tenantId: "t1" });
    const outcome = await service.begin({ key: "k", requestHash: HASH });
    if (outcome.kind !== "fresh") throw new Error("expected fresh");
    await outcome.commit(200, {});

    // Scoped WHERE composes 2 predicates (tenant + key) → an and() SQL wrapper.
    expect(renderSql(selectWheres[0])).toContain('"tenant_id"');
    expect(insertValues.mock.calls[0]![0]).toHaveProperty("tenantId", "t1");
  });

  it("omits tenantId from queries and inserts when unscoped", async () => {
    const { db, selectWheres, insertValues } = makeDb([]);
    const service = createIdempotencyService({ db, table: idempotencyKey, dateProvider });
    const outcome = await service.begin({ key: "k", requestHash: HASH });
    if (outcome.kind !== "fresh") throw new Error("expected fresh");
    await outcome.commit(200, {});

    // Unscoped WHERE is the lone key predicate — no tenant_id reference.
    expect(renderSql(selectWheres[0])).not.toContain("tenant_id");
    expect(insertValues.mock.calls[0]![0]).not.toHaveProperty("tenantId");
  });
});
