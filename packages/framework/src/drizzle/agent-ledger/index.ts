/**
 * @octabits-io/framework/drizzle/agent-ledger — the append-only record of
 * what agents did, under whose grant, and how to undo it.
 *
 * One row per applied agent action, whether it waited for a human decision
 * (`reviewed`), ran under a grant that allowed it to skip review (`autopilot`),
 * or was a person acting directly (`manual`). The row carries the **delegation
 * chain** (`actor`, `onBehalfOf`, `authorizationId`), the **operations exactly
 * as written** including what each replaced, the ids the host assigned to
 * creates, and the **reversibility class** of the whole application. Revert
 * reads this row and nothing else — it never re-reads the entity to guess what
 * "before" was.
 *
 * This is the audit and undo log, not the system of record: rows stay the
 * truth; the ledger says who changed them and how to put them back. It is
 * deliberately not event sourcing.
 *
 * The record types are **structural duplicates** of `../../proposal`'s
 * (`Principal`, `Reversibility`, the resolved operations) — no import, the same
 * decoupling `./job-audit-store` uses for queue. The proposal module is a leaf
 * that nothing in this package imports, so a host that stores proposal
 * operations here does so as `unknown`, and the module works just as well for
 * an agent action that never went through a proposal.
 *
 * Build the table from {@link agentLedgerColumns} plus your own scope column,
 * if any. See {@link createDrizzleAgentLedgerStore} for the scoping rules.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { bigserial, text, timestamp } from 'drizzle-orm/pg-core';
import { jsonbSafe } from '../scope/index.ts';
import { type OctError, type Result, ok, err } from '../../result/index.ts';
import type { DbInsertTarget, DbSelectSource, DbUpdateTarget } from '../db/index.ts';
import type { DrizzleView } from '../db/internal.ts';

// ---------------------------------------------------------------------------
// Column-set (extension mechanism)
// ---------------------------------------------------------------------------

/**
 * Generic ledger columns — one row per applied agent action. The
 * **scope-reference column is intentionally not part of the set**: declare it
 * yourself so you own its name, type, FK, and nullability, and omit it
 * entirely in a single-scope deployment.
 *
 * ```ts
 * export const agentLedger = pgTable(
 *   'agent_ledger',
 *   { ...agentLedgerColumns, tenantId: text('tenant_id').notNull() },
 *   (t) => [
 *     index('agent_ledger_actor_idx').on(t.tenantId, t.actorId, t.appliedAt),
 *     index('agent_ledger_workflow_idx').on(t.workflowId),
 *   ],
 * );
 * ```
 */
export const agentLedgerColumns = {
  id: bigserial({ mode: 'number' }).primaryKey().notNull(),
  /** `'agent'` | `'user'` | `'system'` — who acted. */
  actorKind: text('actor_kind').notNull(),
  /** The acting subject's id (`'ai:guest-reply'`, a user id). */
  actorId: text('actor_id').notNull(),
  actorLabel: text('actor_label'),
  /** For an agent: the user whose grant it acted under. */
  onBehalfOf: text('on_behalf_of'),
  /** For an agent: the grant that permitted the action. */
  authorizationId: text('authorization_id'),
  /** `'reviewed'` | `'autopilot'` | `'manual'` — when the apply happened relative to a human. */
  mode: text().notNull(),
  /** What the action was about, in the host's addressing vocabulary (`'listing:88'`). */
  scope: text().notNull(),
  /** The run that produced the action, when one did. Text, so any engine's id fits. */
  workflowId: text('workflow_id'),
  /** The reviewer's decision, when there was a review. `null` on autopilot and manual. */
  decision: jsonbSafe(),
  /** The operations exactly as written — edits folded in, what each replaced intact. */
  operations: jsonbSafe().notNull(),
  /** Ids the host assigned to creates, by the create's `ref`. `null` when nothing was created. */
  created: jsonbSafe(),
  /** `'reversible'` | `'compensable'` | `'irreversible'` — the worst class among the operations. */
  reversibility: text().notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  revertedAt: timestamp('reverted_at', { withTimezone: true, mode: 'string' }),
  /** Who reverted — a user id, or the agent on a self-correction. */
  revertedBy: text('reverted_by'),
};

// ---------------------------------------------------------------------------
// Structural duplicates of the proposal contract's actor + reversibility
// ---------------------------------------------------------------------------

export type LedgerActorKind = 'agent' | 'user' | 'system';

/** Who acted, for whom, under which grant. Same shape as the proposal contract's `Principal`. */
export interface LedgerPrincipal {
  kind: LedgerActorKind;
  id: string;
  label?: string;
  onBehalfOf?: string;
  authorizationId?: string;
}

/**
 * When the apply happened relative to a human:
 *   `reviewed`  — a person decided first (a proposal awaited a decision).
 *   `autopilot` — the agent applied under a grant that allowed it to skip review.
 *   `manual`    — a person acted directly; the ledger still records it so the
 *                 timeline is one list.
 */
export type LedgerMode = 'reviewed' | 'autopilot' | 'manual';

export type LedgerReversibility = 'reversible' | 'compensable' | 'irreversible';

/** What a host hands to {@link DrizzleAgentLedgerStore.record}. */
export interface AgentLedgerEntryInput {
  principal: LedgerPrincipal;
  mode: LedgerMode;
  scope: string;
  workflowId?: string | number;
  /** The decision a reviewer made, if any — stored verbatim. */
  decision?: unknown;
  /** The operations as written. A proposal host stores its `ResolvedOperation[]`; the ledger does not interpret them. */
  operations: unknown;
  created?: Record<string, string>;
  reversibility: LedgerReversibility;
  /** Defaults to the database's `now()`. */
  appliedAt?: string;
  /** Scope value for this row when the store stamps a scope column without a fixed value. */
  scopeKey?: string;
}

/** A ledger row as read back. */
export interface AgentLedgerEntry {
  id: number;
  principal: LedgerPrincipal;
  mode: LedgerMode;
  scope: string;
  workflowId: string | null;
  decision: unknown;
  operations: unknown;
  created: Record<string, string>;
  reversibility: LedgerReversibility;
  appliedAt: string;
  revertedAt: string | null;
  revertedBy: string | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** A storage-layer failure (connection loss, constraint violation, bad SQL, …). */
export interface AgentLedgerStoreFailureError extends OctError {
  key: 'agent_ledger_store_failure';
}

export type AgentLedgerStoreError = AgentLedgerStoreFailureError;

/**
 * The scope column this store stamps, if any. `column` is the TypeScript
 * property name on the Drizzle table. With a fixed `value` every row gets it;
 * without one the value is read per entry from `entry.scopeKey`, and an entry
 * that has none is refused rather than written unscoped — a ledger row with
 * no owner is worse than a failed write.
 */
export interface AgentLedgerScope {
  column: string;
  value?: string;
}

export interface DrizzleAgentLedgerStore {
  /** Append one row. Returns it as stored, with its id and timestamp. */
  record(entry: AgentLedgerEntryInput): Promise<Result<AgentLedgerEntry, AgentLedgerStoreError>>;
  get(id: number): Promise<Result<AgentLedgerEntry | null, AgentLedgerStoreError>>;
  /** The most recent row for a workflow — the one that stands, applied or reverted. */
  findByWorkflow(workflowId: string | number): Promise<Result<AgentLedgerEntry | null, AgentLedgerStoreError>>;
  /** Batched form of {@link findByWorkflow}, for list projections: latest row per workflow. */
  findByWorkflows(
    workflowIds: ReadonlyArray<string | number>,
  ): Promise<Result<Map<string, AgentLedgerEntry>, AgentLedgerStoreError>>;
  /** "Everything agent X did", newest first — the per-agent timeline. */
  listByActor(
    actorId: string,
    options?: { limit?: number },
  ): Promise<Result<AgentLedgerEntry[], AgentLedgerStoreError>>;
  /** Mark a row reverted. The row itself is never deleted or rewritten otherwise. */
  markReverted(id: number, by: { at?: string; by: string }): Promise<Result<void, AgentLedgerStoreError>>;
}

/**
 * Minimal structural view of a Drizzle Postgres db — the `../db` capability
 * atoms this module uses. Satisfied by an augmented `AppDatabase` AND by
 * transaction contexts.
 */
export interface AgentLedgerStoreDatabase extends DbSelectSource, DbInsertTarget, DbUpdateTarget {}

export interface CreateDrizzleAgentLedgerStoreDeps {
  db: AgentLedgerStoreDatabase;
  /** The ledger Drizzle table (columns per {@link agentLedgerColumns} + your scope column). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Scope column to stamp and filter by. Omit entirely in a single-scope deployment. */
  scope?: AgentLedgerScope;
}

const failure = (what: string, error: unknown): AgentLedgerStoreFailureError => ({
  key: 'agent_ledger_store_failure',
  message: `${what}: ${error instanceof Error ? error.message : String(error)}`,
});

/** Row (Drizzle property names) → entry. */
function toEntry(row: Record<string, unknown>): AgentLedgerEntry {
  const principal: LedgerPrincipal = { kind: row.actorKind as LedgerActorKind, id: row.actorId as string };
  if (row.actorLabel != null) principal.label = row.actorLabel as string;
  if (row.onBehalfOf != null) principal.onBehalfOf = row.onBehalfOf as string;
  if (row.authorizationId != null) principal.authorizationId = row.authorizationId as string;
  return {
    id: row.id as number,
    principal,
    mode: row.mode as LedgerMode,
    scope: row.scope as string,
    workflowId: (row.workflowId as string | null) ?? null,
    decision: row.decision ?? null,
    operations: row.operations,
    created: (row.created as Record<string, string> | null) ?? {},
    reversibility: row.reversibility as LedgerReversibility,
    // `mode: 'string'` hands back Postgres' own text form ("2026-09-03 18:13:11.09+00");
    // consumers and the in-memory store speak ISO, so the row does too.
    appliedAt: toIso(row.appliedAt as string),
    revertedAt: row.revertedAt == null ? null : toIso(row.revertedAt as string),
    revertedBy: (row.revertedBy as string | null) ?? null,
  };
}

/**
 * Build the Drizzle ledger store.
 *
 * ```ts
 * const ledger = createDrizzleAgentLedgerStore({ db, table: schema.agentLedger, scope: { column: 'tenantId', value: tenantId } });
 *
 * // after applying a reviewed proposal:
 * await ledger.record({
 *   principal: { kind: 'agent', id: 'ai:listing-fields', onBehalfOf: userId, authorizationId: grantId },
 *   mode: 'reviewed', scope: proposal.scope, workflowId, decision,
 *   operations: resolved, created, reversibility: reversibilityOf(resolved),
 * });
 * ```
 *
 * Scoping: no `scope` → nothing stamped or filtered; `{ column, value }` →
 * every row stamped with and every read filtered by that value;
 * `{ column }` → stamped from `entry.scopeKey` (refused when absent) and reads
 * are unfiltered — for a process-wide writer that serves many scopes.
 */
const toIso = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

export function createDrizzleAgentLedgerStore(deps: CreateDrizzleAgentLedgerStoreDeps): DrizzleAgentLedgerStore {
  const { db, table, scope } = deps;
  // Internal typed view (see ../db/internal.ts): the public seam stays
  // structural; the chains below typecheck against drizzle's real declarations.
  const view = db as unknown as DrizzleView;

  const scopeFilter = () => (scope?.value !== undefined ? eq(table[scope.column], scope.value) : undefined);
  const withScope = (condition: ReturnType<typeof eq>) => {
    const filter = scopeFilter();
    return filter ? and(filter, condition) : condition;
  };

  async function record(entry: AgentLedgerEntryInput): Promise<Result<AgentLedgerEntry, AgentLedgerStoreError>> {
    let scopeStamp: Record<string, string> = {};
    if (scope) {
      const value = scope.value ?? entry.scopeKey;
      if (value == null) {
        return err({ key: 'agent_ledger_store_failure', message: 'Ledger entry has no scope and the store stamps one' });
      }
      scopeStamp = { [scope.column]: value };
    }

    try {
      const rows = (await view
        .insert(table)
        .values({
          ...scopeStamp,
          actorKind: entry.principal.kind,
          actorId: entry.principal.id,
          actorLabel: entry.principal.label ?? null,
          onBehalfOf: entry.principal.onBehalfOf ?? null,
          authorizationId: entry.principal.authorizationId ?? null,
          mode: entry.mode,
          scope: entry.scope,
          workflowId: entry.workflowId === undefined ? null : String(entry.workflowId),
          decision: entry.decision ?? null,
          operations: entry.operations,
          created: entry.created ?? null,
          reversibility: entry.reversibility,
          ...(entry.appliedAt !== undefined ? { appliedAt: entry.appliedAt } : {}),
        })
        .returning()) as Record<string, unknown>[];
      const row = rows[0];
      if (!row) return err({ key: 'agent_ledger_store_failure', message: 'Insert returned no row' });
      return ok(toEntry(row));
    } catch (error) {
      return err(failure(`Failed to record ledger entry for ${entry.scope}`, error));
    }
  }

  async function get(id: number): Promise<Result<AgentLedgerEntry | null, AgentLedgerStoreError>> {
    try {
      const rows = (await view.select().from(table).where(withScope(eq(table.id, id))).limit(1)) as Record<string, unknown>[];
      return ok(rows[0] ? toEntry(rows[0]) : null);
    } catch (error) {
      return err(failure(`Failed to read ledger entry ${id}`, error));
    }
  }

  async function findByWorkflows(
    workflowIds: ReadonlyArray<string | number>,
  ): Promise<Result<Map<string, AgentLedgerEntry>, AgentLedgerStoreError>> {
    if (workflowIds.length === 0) return ok(new Map());
    try {
      const rows = (await view
        .select()
        .from(table)
        .where(withScope(inArray(table.workflowId, workflowIds.map(String))))
        .orderBy(desc(table.appliedAt), desc(table.id))) as Record<string, unknown>[];
      // Newest first, so the first row seen per workflow is the one that stands.
      const latest = new Map<string, AgentLedgerEntry>();
      for (const row of rows) {
        const entry = toEntry(row);
        if (entry.workflowId !== null && !latest.has(entry.workflowId)) latest.set(entry.workflowId, entry);
      }
      return ok(latest);
    } catch (error) {
      return err(failure('Failed to read ledger entries by workflow', error));
    }
  }

  async function findByWorkflow(workflowId: string | number): Promise<Result<AgentLedgerEntry | null, AgentLedgerStoreError>> {
    const found = await findByWorkflows([workflowId]);
    return found.ok ? ok(found.value.get(String(workflowId)) ?? null) : found;
  }

  async function listByActor(
    actorId: string,
    options: { limit?: number } = {},
  ): Promise<Result<AgentLedgerEntry[], AgentLedgerStoreError>> {
    try {
      const rows = (await view
        .select()
        .from(table)
        .where(withScope(eq(table.actorId, actorId)))
        .orderBy(desc(table.appliedAt), desc(table.id))
        .limit(options.limit ?? 50)) as Record<string, unknown>[];
      return ok(rows.map(toEntry));
    } catch (error) {
      return err(failure(`Failed to list ledger entries for ${actorId}`, error));
    }
  }

  async function markReverted(id: number, by: { at?: string; by: string }): Promise<Result<void, AgentLedgerStoreError>> {
    try {
      await view
        .update(table)
        .set({ revertedAt: by.at ?? new Date().toISOString(), revertedBy: by.by })
        .where(withScope(eq(table.id, id)));
      return ok(undefined);
    } catch (error) {
      return err(failure(`Failed to mark ledger entry ${id} reverted`, error));
    }
  }

  return { record, get, findByWorkflow, findByWorkflows, listByActor, markReverted };
}

/**
 * The no-database twin — for tests and in-memory demos. Same contract, same
 * "latest row per workflow" semantics.
 */
export function createInMemoryAgentLedgerStore(): DrizzleAgentLedgerStore {
  const rows: AgentLedgerEntry[] = [];
  let nextId = 1;

  const newestFirst = (a: AgentLedgerEntry, b: AgentLedgerEntry) =>
    b.appliedAt.localeCompare(a.appliedAt) || b.id - a.id;

  return {
    async record(entry) {
      const stored: AgentLedgerEntry = {
        id: nextId++,
        principal: { ...entry.principal },
        mode: entry.mode,
        scope: entry.scope,
        workflowId: entry.workflowId === undefined ? null : String(entry.workflowId),
        decision: entry.decision ?? null,
        operations: entry.operations,
        created: { ...(entry.created ?? {}) },
        reversibility: entry.reversibility,
        appliedAt: entry.appliedAt ?? new Date().toISOString(),
        revertedAt: null,
        revertedBy: null,
      };
      rows.push(stored);
      return ok({ ...stored });
    },
    async get(id) {
      const row = rows.find((r) => r.id === id);
      return ok(row ? { ...row } : null);
    },
    async findByWorkflow(workflowId) {
      const row = rows.filter((r) => r.workflowId === String(workflowId)).sort(newestFirst)[0];
      return ok(row ? { ...row } : null);
    },
    async findByWorkflows(workflowIds) {
      const wanted = new Set(workflowIds.map(String));
      const latest = new Map<string, AgentLedgerEntry>();
      for (const row of [...rows].sort(newestFirst)) {
        if (row.workflowId !== null && wanted.has(row.workflowId) && !latest.has(row.workflowId)) {
          latest.set(row.workflowId, { ...row });
        }
      }
      return ok(latest);
    },
    async listByActor(actorId, options = {}) {
      return ok(
        rows
          .filter((r) => r.principal.id === actorId)
          .sort(newestFirst)
          .slice(0, options.limit ?? 50)
          .map((r) => ({ ...r })),
      );
    },
    async markReverted(id, by) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.revertedAt = by.at ?? new Date().toISOString();
        row.revertedBy = by.by;
      }
      return ok(undefined);
    },
  };
}
