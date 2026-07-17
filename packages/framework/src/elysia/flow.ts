/**
 * Read-side route factory for `@octabits-io/flow` workflow engines — the
 * framework's HTTP opinions layered over flow's public wire view.
 *
 * The layering is deliberate: flow owns the *shapes* (`toPublicWorkflow` +
 * `PUBLIC_WORKFLOW_SCHEMA` project engine records, dropping internals and
 * folding engine step statuses to display states — see flow's public-view
 * module), and this factory owns the *serving conventions* every octabits API
 * repeats: declared `response` schemas (Eden narrowing + OpenAPI), error-key →
 * status mapping via {@link createErrorMapper}, and the 200-with-body cancel
 * response (a 204 with Elysia's empty-string body trips node's `Response`
 * constructor — bun does not mind, vitest-driven `app.handle` does).
 *
 * Only the routes that are identical for every flow consumer live here — pure
 * engine projections: list, active-probe, get, status snapshot, cancel,
 * resume. **Start/trigger routes stay in the app**: their body schema is
 * domain vocabulary, the `entityRef` format is an app convention, and
 * quota/auth policy is app policy.
 *
 * Consumer seams (all optional; a single-scope app needs none of them):
 *
 * - `engine` may be the engine itself or a **per-request resolver**
 *   `(ctx) => engine` — for hosts whose engine is partition-scoped and lives
 *   in a request scope (e.g. resolved off `ctx.scope`).
 * - `authorize(action, ctx)` gates each route; return a keyed error (e.g.
 *   `{ key: 'forbidden', … }` → 403 by convention) to reject.
 * - `extendWorkflow` adds consumer wire fields. `schema` extends
 *   `PUBLIC_WORKFLOW_SCHEMA`; `load(workflows, ctx)` is an optional **batched**
 *   async fetch (side-table joins — called once per request, not per row);
 *   `project(workflow, loaded)` produces the values, spread over
 *   `toPublicWorkflow(...)`. Schema and projection travel together so the
 *   declared type and the served value cannot drift:
 *
 * ```ts
 * new Elysia({ prefix: '/ai' }).use(createFlowWorkflowRoutes({
 *   engine: (ctx) => (ctx as { scope: Scope }).scope.resolve('workflowEngine').reader,
 *   authorize: (action, ctx) => checkPerm(ctx, action === 'cancel' || action === 'resume'
 *     ? { jobs: ['cancel'] } : { jobs: ['read'] }),
 *   errorOverrides: { ai_quota_exceeded: 429 },
 *   extendWorkflow: {
 *     schema: { appliedAt: z.string().nullable() },
 *     load: (workflows, ctx) => loadMetaRows(ctx, workflows.map((w) => w.id)),
 *     project: (wf, meta) => ({ appliedAt: meta?.get(wf.id)?.appliedAt ?? null }),
 *   },
 * }))
 * ```
 *
 * Map/sub-workflow **child steps are engine mechanics** and are excluded from
 * the wire step list by default (`includeChildSteps: true` opts back in) —
 * the same philosophy as flow's status fold.
 *
 * `@octabits-io/flow` is an OPTIONAL peer — only pulled in by consumers of
 * this `./elysia/flow` subpath, keeping the root `./elysia` export free of it
 * (the same arrangement as `./elysia/mcp` and its MCP peers).
 *
 * The engine parameter is structural ({@link FlowEngineReader}): any object
 * with the four read/control methods fits — the real engine, a partition-bound
 * wrapper, or a test double.
 */
import { Elysia } from 'elysia';
import { z } from 'zod';
import {
  PUBLIC_WORKFLOW_SCHEMA,
  WORKFLOW_STATUS_SCHEMA,
  toPublicWorkflow,
  toPublicStep,
  type PublicWorkflow,
  type WorkflowStatus,
  type WorkflowWithSteps,
} from '@octabits-io/flow';
import { createErrorMapper, type ErrorStatusOverrides, type KeyedError } from './errors.ts';
import { errorResponses } from './responses.ts';

/** Structural result — matches flow's `Result` without naming it. */
type FlowResult<T> = { ok: true; value: T } | { ok: false; error: { key: string; message: string } };

type MaybePromise<T> = T | Promise<T>;

/**
 * The slice of a flow engine these routes need. `WorkflowEngine<TContext>` from
 * `createWorkflowEngine` satisfies this for any `TContext`.
 */
export interface FlowEngineReader {
  getWorkflowStatus(workflowId: number): Promise<FlowResult<WorkflowWithSteps>>;
  listWorkflows(filters: {
    status?: WorkflowStatus;
    type?: string;
    entityRef?: string;
    limit?: number;
  }): Promise<FlowResult<WorkflowWithSteps[]>>;
  cancelWorkflow(workflowId: number): Promise<FlowResult<void>>;
  resumeStep(
    workflowId: number,
    stepKey: string,
    payload?: Record<string, unknown>,
  ): Promise<FlowResult<void>>;
}

/**
 * The engine, or a per-request resolver for hosts whose engine is
 * partition-scoped (resolved from a request scope). The resolver receives the
 * Elysia handler context as `unknown` — narrow it to whatever your request
 * -scope plugin decorates.
 */
export type FlowEngineSource = FlowEngineReader | ((ctx: unknown) => MaybePromise<FlowEngineReader>);

/** The route being authorized. Reads vs. mutations, for permission mapping. */
export type FlowRouteAction = 'list' | 'active' | 'get' | 'status' | 'cancel' | 'resume';

/**
 * Consumer fields added to the wire shape. `schema` extends
 * `PUBLIC_WORKFLOW_SCHEMA`; `project` produces the matching values, spread
 * over `toPublicWorkflow(...)`. One seam for both keeps schema and value in
 * lockstep. The optional `load` runs ONCE per request over the full result set
 * (batch your side-table reads there); its result is handed to every
 * `project` call.
 */
export interface WorkflowViewExtension<TExt extends z.ZodRawShape, TLoad = unknown> {
  schema: TExt;
  /** Batched per-request fetch of whatever `project` needs (side-table rows, …). */
  load?: (workflows: WorkflowWithSteps[], ctx: unknown) => MaybePromise<TLoad>;
  project: (workflow: WorkflowWithSteps, loaded: TLoad | undefined) => z.infer<z.ZodObject<TExt>>;
}

export interface CreateFlowWorkflowRoutesOptions<
  TExt extends z.ZodRawShape,
  TLoad,
  TPrefix extends string = '/workflows',
> {
  engine: FlowEngineSource;
  /**
   * Route prefix. Default `'/workflows'`. Typed as a literal on purpose — a
   * plain `string` widens Elysia's BasePath and collapses every route key in
   * the emitted type to an index signature, which makes the routes invisible
   * to Eden.
   */
  prefix?: TPrefix;
  /** OpenAPI tags. Default `['Workflows']`. */
  tags?: string[];
  /**
   * Per-route permission gate. Return a keyed error to reject (mapped through
   * the same error conventions — `forbidden` → 403, etc.); return nothing to
   * allow. Receives the Elysia handler context as `unknown`.
   */
  authorize?: (action: FlowRouteAction, ctx: unknown) => MaybePromise<KeyedError | undefined | void>;
  /** Domain key → status overrides merged into the framework conventions (e.g. `{ ai_quota_exceeded: 429 }`). */
  errorOverrides?: ErrorStatusOverrides;
  /** List-route page size bounds. Default `{ max: 50, default: 20 }`. */
  listLimit?: { max?: number; default?: number };
  /**
   * Include map/sub-workflow child steps in the wire step list. Default
   * `false` — children are engine mechanics; the keyed steps are the DAG the
   * caller declared.
   */
  includeChildSteps?: boolean;
  /** Consumer fields on the workflow wire shape (see {@link WorkflowViewExtension}). */
  extendWorkflow?: WorkflowViewExtension<TExt, TLoad>;
}

/**
 * Path params for the `/:id` routes. Loose on purpose: consumers mount these
 * routes under parent prefixes carrying their own path params (e.g.
 * `/tenant/:tenantId`), and a strict object would strip those keys during
 * validation — BEFORE the consumer's request-scope plugin reads them.
 */
const SCHEMA_ID_PARAM = z.looseObject({ id: z.coerce.number().int().positive() });

const SCHEMA_STATUS_SNAPSHOT = z.object({
  status: WORKFLOW_STATUS_SCHEMA,
  totalSteps: z.number().int(),
  completedSteps: z.number().int(),
});

/**
 * Build the generic read/control routes over a flow engine:
 *
 * - `GET    <prefix>`             — list, newest first (`entityRef`/`status`/`type`/`limit` filters)
 * - `GET    <prefix>/active`      — "anything in flight for this entity?" (trigger-button probe)
 * - `GET    <prefix>/:id`         — one workflow with steps, public view
 * - `GET    <prefix>/:id/status`  — light snapshot (cross-page progress polling)
 * - `POST   <prefix>/:id/cancel`  — cancel (no-op ok on already-terminal workflows)
 * - `POST   <prefix>/:id/resume`  — deliver an external event to a `waiting` step
 */
export function createFlowWorkflowRoutes<
  TExt extends z.ZodRawShape = Record<string, never>,
  TLoad = unknown,
  TPrefix extends string = '/workflows',
>(options: CreateFlowWorkflowRoutesOptions<TExt, TLoad, TPrefix>) {
  const { statusErrorWithSet } = createErrorMapper(options.errorOverrides ?? {});
  const limitMax = options.listLimit?.max ?? 50;
  const limitDefault = options.listLimit?.default ?? 20;
  const ext = options.extendWorkflow;

  const resolveEngine = (ctx: unknown): MaybePromise<FlowEngineReader> =>
    typeof options.engine === 'function' ? options.engine(ctx) : options.engine;

  /** Returns the rejection body (already status-mapped via `set`) or null to proceed. */
  async function deny(action: FlowRouteAction, ctx: unknown, set: { status?: number | string }) {
    if (!options.authorize) return null;
    const rejected = await options.authorize(action, ctx);
    if (!rejected) return null;
    return statusErrorWithSet(set as Parameters<typeof statusErrorWithSet>[0], rejected);
  }

  const workflowSchema = PUBLIC_WORKFLOW_SCHEMA.extend(ext?.schema ?? ({} as TExt));
  // Typed off the schema value so the handler return type and the declared
  // `response` schema unify for Elysia (and therefore for Eden).
  type WorkflowView = z.output<typeof workflowSchema>;

  const projectSteps = (workflow: WorkflowWithSteps) =>
    (options.includeChildSteps
      ? workflow.steps
      : workflow.steps.filter((step) => step.parentStepId == null)
    ).map(toPublicStep);

  const toView = (workflow: WorkflowWithSteps, loaded: TLoad | undefined): WorkflowView =>
    ({
      ...toPublicWorkflow(workflow),
      steps: projectSteps(workflow),
      ...(ext?.project(workflow, loaded) ?? {}),
    }) as PublicWorkflow & z.infer<z.ZodObject<TExt>> as WorkflowView;

  const loadFor = async (workflows: WorkflowWithSteps[], ctx: unknown): Promise<TLoad | undefined> =>
    ext?.load ? await ext.load(workflows, ctx) : undefined;

  return new Elysia({
    prefix: (options.prefix ?? '/workflows') as TPrefix,
    tags: options.tags ?? ['Workflows'],
  })
    .get(
      // '' (not '/'): under a prefixed parent, prefix + '/' only matches the
      // trailing-slash form; '' matches the exact prefix path in both layouts.
      '',
      async (ctx) => {
        const { query, set } = ctx;
        const denied = await deny('list', ctx, set);
        if (denied) return denied;
        // Newest first (stores order by id DESC) — `entityRef` + `limit: 1` is
        // a client's "latest run for this entity" rehydration read.
        const engine = await resolveEngine(ctx);
        const listed = await engine.listWorkflows({
          entityRef: query.entityRef,
          status: query.status,
          type: query.type,
          limit: query.limit,
        });
        if (!listed.ok) return statusErrorWithSet(set, listed.error);
        const loaded = await loadFor(listed.value, ctx);
        return { items: listed.value.map((workflow) => toView(workflow, loaded)) };
      },
      {
        query: z.object({
          entityRef: z.string().min(1).optional(),
          status: WORKFLOW_STATUS_SCHEMA.optional(),
          type: z.string().min(1).optional(),
          limit: z.coerce.number().int().positive().max(limitMax).default(limitDefault),
        }),
        response: { 200: z.object({ items: z.array(workflowSchema) }), ...errorResponses(400, 403, 429, 500) },
        detail: { summary: 'List workflows, newest first' },
      },
    )
    .get(
      '/active',
      async (ctx) => {
        const { query, set } = ctx;
        const denied = await deny('active', ctx, set);
        if (denied) return denied;
        const engine = await resolveEngine(ctx);
        const listed = await engine.listWorkflows({ entityRef: query.entityRef, limit: limitMax });
        if (!listed.ok) return statusErrorWithSet(set, listed.error);
        return { active: listed.value.some((w) => w.status === 'pending' || w.status === 'running') };
      },
      {
        query: z.object({ entityRef: z.string().min(1) }),
        response: { 200: z.object({ active: z.boolean() }), ...errorResponses(400, 403, 429, 500) },
        detail: { summary: 'Whether a workflow is in flight for an entity' },
      },
    )
    .get(
      '/:id',
      async (ctx) => {
        const { params, set } = ctx;
        // `as never` on the return branches: while TExt is generic, the 200
        // schema's output type is an unresolved conditional, so TS can prove
        // no branch a member of Elysia's response union (the `{ items }`-
        // wrapped list route unifies fine). Client/Eden types are unaffected —
        // they derive from the `response` schema map, not the handler return.
        const denied = await deny('get', ctx, set);
        if (denied) return denied as never;
        const engine = await resolveEngine(ctx);
        const status = await engine.getWorkflowStatus(params.id);
        if (!status.ok) return statusErrorWithSet(set, status.error) as never;
        const loaded = await loadFor([status.value], ctx);
        return toView(status.value, loaded) as never;
      },
      {
        params: SCHEMA_ID_PARAM,
        response: { 200: workflowSchema, ...errorResponses(400, 403, 404, 429, 500) },
        detail: { summary: 'Get one workflow with its steps' },
      },
    )
    .get(
      '/:id/status',
      async (ctx) => {
        const { params, set } = ctx;
        const denied = await deny('status', ctx, set);
        if (denied) return denied;
        const engine = await resolveEngine(ctx);
        const status = await engine.getWorkflowStatus(params.id);
        if (!status.ok) return statusErrorWithSet(set, status.error);
        const { status: workflowStatus, totalSteps, completedSteps } = status.value;
        return { status: workflowStatus, totalSteps, completedSteps };
      },
      {
        params: SCHEMA_ID_PARAM,
        response: { 200: SCHEMA_STATUS_SNAPSHOT, ...errorResponses(400, 403, 404, 429, 500) },
        detail: { summary: 'Get a workflow status snapshot' },
      },
    )
    .post(
      '/:id/cancel',
      async (ctx) => {
        const { params, set } = ctx;
        const denied = await deny('cancel', ctx, set);
        if (denied) return denied;
        const engine = await resolveEngine(ctx);
        const cancelled = await engine.cancelWorkflow(params.id);
        if (!cancelled.ok) return statusErrorWithSet(set, cancelled.error);
        return { cancelled: true };
      },
      {
        params: SCHEMA_ID_PARAM,
        response: { 200: z.object({ cancelled: z.boolean() }), ...errorResponses(400, 403, 404, 429, 500) },
        detail: { summary: 'Cancel a running workflow' },
      },
    )
    .post(
      '/:id/resume',
      async (ctx) => {
        const { params, body, set } = ctx;
        const denied = await deny('resume', ctx, set);
        if (denied) return denied;
        const engine = await resolveEngine(ctx);
        const resumed = await engine.resumeStep(params.id, body.stepKey, body.payload);
        if (!resumed.ok) return statusErrorWithSet(set, resumed.error);
        return { resumed: true };
      },
      {
        params: SCHEMA_ID_PARAM,
        body: z.object({
          stepKey: z.string().min(1),
          payload: z.record(z.string(), z.unknown()).optional(),
        }),
        response: { 200: z.object({ resumed: z.boolean() }), ...errorResponses(400, 403, 404, 409, 429, 500) },
        detail: { summary: "Deliver an external event to a waiting step" },
      },
    );
}
