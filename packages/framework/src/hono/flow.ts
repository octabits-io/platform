/**
 * Hono port of `../elysia/flow` — read-side routes for `@octabits-io/flow`
 * workflow engines, the framework's HTTP opinions layered over flow's public
 * wire view.
 *
 * The layering is unchanged: flow owns the *shapes* (`toPublicWorkflow` +
 * `PUBLIC_WORKFLOW_SCHEMA` project engine records, dropping internals and
 * folding engine step statuses to display states), and this factory owns the
 * *serving conventions*: error-key → status mapping via {@link createErrorMapper},
 * and the 200-with-body cancel response (kept for wire parity with the Elysia
 * factory — reynt clients read `{ cancelled: true }`).
 *
 * Only the routes that are identical for every flow consumer live here — pure
 * engine projections: list, active-probe, get, status snapshot, cancel,
 * resume. **Start/trigger routes stay in the app**: their body schema is
 * domain vocabulary, the `entityRef` format is an app convention, and
 * quota/auth policy is app policy.
 *
 * Differences from the Elysia factory (see the migration notes):
 *
 * - **No `prefix` option and no literal-prefix generic.** The caller mounts the
 *   sub-app: `app.route('/api/ai/workflows', createFlowWorkflowRoutes(...))`.
 *   Hono's `route()` prepends the mount path to each copied route, so the paths
 *   stay visible to `hc` — the whole reason Elysia needed the literal generic.
 * - **The app is ONE method chain.** Hono accumulates route types through
 *   chaining; assigning to a mutated `app` variable loses them for `hc`.
 * - **No `response` schema maps.** Hono does not validate responses and has no
 *   built-in OpenAPI; the client type comes from the handlers' `c.json(...)`
 *   returns instead. The zod shapes are still exported (see
 *   {@link buildFlowWorkflowSchema} and the `SCHEMA_*` consts) so an
 *   `@hono/zod-openapi` layer — or a consumer's own docs — can declare the same
 *   contract, and so the served value has a schema to be checked against.
 * - **No `tags` option** — OpenAPI grouping belongs to that separate opt-in.
 * - **Strict path params.** Elysia needed `z.looseObject` because its params
 *   validation *replaced* `ctx.params`, stripping a parent prefix's own params
 *   (`/tenant/:tenantId`). Hono keeps validated data beside the raw params, so
 *   `c.req.param('tenantId')` still resolves in the engine resolver and a strict
 *   object is correct here.
 *
 * Consumer seams (all optional; a single-scope app needs none of them):
 *
 * - `engine` may be the engine itself or a **per-request resolver**
 *   `(ctx) => engine` — for hosts whose engine is partition-scoped and lives in
 *   a request scope. The `ctx` handed to it is the Hono {@link Context}.
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
 * app.route('/ai/workflows', createFlowWorkflowRoutes({
 *   engine: (ctx) => (ctx as Context).get('scope').resolve('workflowEngine').reader,
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
 * the wire step list by default (`includeChildSteps: true` opts back in) — the
 * same philosophy as flow's status fold.
 *
 * Error bodies are produced inline (`{ key, message }` + the mapped status), so
 * the sub-app is self-contained on the domain-error path. Schema failures throw
 * `RequestValidationError` from {@link octValidator} and therefore still need
 * the host app's `registerErrorHandler` — the same arrangement as every other
 * validated route in `./hono`.
 *
 * `@octabits-io/flow` is an OPTIONAL peer — only pulled in by consumers of this
 * `./hono/flow` subpath, keeping the root `./hono` export free of it (the same
 * arrangement as `./hono/mcp` and its MCP peers).
 *
 * The engine parameter is structural ({@link FlowEngineReader}): any object with
 * the four read/control methods fits — the real engine, a partition-bound
 * wrapper, or a test double.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
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
import type { ErrorStatusOverrides, KeyedError } from '../server/errors.ts';
import { createErrorJson, octValidator } from './errors.ts';

/** Structural result — matches flow's `Result` without naming it. */
type FlowResult<T> = { ok: true; value: T } | { ok: false; error: { key: string; message: string } };

type MaybePromise<T> = T | Promise<T>;

/**
 * The slice of a flow engine these routes need. `WorkflowEngine<TContext>` from
 * `createWorkflowEngine` satisfies this for any `TContext`.
 *
 * Structurally identical to `../elysia/flow`'s contract and deliberately
 * duplicated: the boundary lint forbids a hono→elysia import, and neither
 * declaration names a framework, so the two cannot drift apart in substance.
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
 * Hono {@link Context} as `unknown` — narrow it to whatever your request-scope
 * middleware sets (`(ctx as Context).get('scope')`).
 */
export type FlowEngineSource = FlowEngineReader | ((ctx: unknown) => MaybePromise<FlowEngineReader>);

/** The route being authorized. Reads vs. mutations, for permission mapping. */
export type FlowRouteAction = 'list' | 'active' | 'get' | 'status' | 'cancel' | 'resume';

/**
 * Consumer fields added to the wire shape. `schema` extends
 * `PUBLIC_WORKFLOW_SCHEMA`; `project` produces the matching values, spread over
 * `toPublicWorkflow(...)`. One seam for both keeps schema and value in lockstep.
 * The optional `load` runs ONCE per request over the full result set (batch your
 * side-table reads there); its result is handed to every `project` call.
 */
export interface WorkflowViewExtension<TExt extends z.ZodRawShape, TLoad = unknown> {
  schema: TExt;
  /** Batched per-request fetch of whatever `project` needs (side-table rows, …). */
  load?: (workflows: WorkflowWithSteps[], ctx: unknown) => MaybePromise<TLoad>;
  project: (workflow: WorkflowWithSteps, loaded: TLoad | undefined) => z.infer<z.ZodObject<TExt>>;
}

export interface CreateFlowWorkflowRoutesOptions<TExt extends z.ZodRawShape, TLoad> {
  engine: FlowEngineSource;
  /**
   * Per-route permission gate. Return a keyed error to reject (mapped through
   * the same error conventions — `forbidden` → 403, etc.); return nothing to
   * allow. Receives the Hono {@link Context} as `unknown`.
   */
  authorize?: (action: FlowRouteAction, ctx: unknown) => MaybePromise<KeyedError | undefined | void>;
  /** Domain key → status overrides merged into the framework conventions (e.g. `{ ai_quota_exceeded: 429 }`). */
  errorOverrides?: ErrorStatusOverrides;
  /** List-route page size bounds. Default `{ max: 50, default: 20 }`. */
  listLimit?: { max?: number; default?: number };
  /**
   * Include map/sub-workflow child steps in the wire step list. Default `false`
   * — children are engine mechanics; the keyed steps are the DAG the caller
   * declared.
   */
  includeChildSteps?: boolean;
  /** Consumer fields on the workflow wire shape (see {@link WorkflowViewExtension}). */
  extendWorkflow?: WorkflowViewExtension<TExt, TLoad>;
}

/**
 * Path params for the `/:id` routes. Strict, unlike the Elysia factory's
 * `z.looseObject`: Hono stores validated data *beside* `c.req.param()` rather
 * than replacing it, so a parent prefix's own params (`/tenant/:tenantId`)
 * survive validation and stay readable from the engine resolver.
 */
export const SCHEMA_ID_PARAM = z.object({ id: z.coerce.number().int().positive() });

/** Query for the active-probe route. */
export const SCHEMA_ACTIVE_QUERY = z.object({ entityRef: z.string().min(1) });

/** Body for the resume route. */
export const SCHEMA_RESUME_BODY = z.object({
  stepKey: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** Light progress projection served by `/:id/status`. */
export const SCHEMA_STATUS_SNAPSHOT = z.object({
  status: WORKFLOW_STATUS_SCHEMA,
  totalSteps: z.number().int(),
  completedSteps: z.number().int(),
});

/** `POST /:id/cancel` response — 200-with-body, not 204 (wire parity). */
export const SCHEMA_CANCEL_RESPONSE = z.object({ cancelled: z.boolean() });

/** `POST /:id/resume` response. */
export const SCHEMA_RESUME_RESPONSE = z.object({ resumed: z.boolean() });

/** The list-route query, whose bounds come from `listLimit` — hence a builder, not a const. */
export function buildFlowListQuerySchema(listLimit?: { max?: number; default?: number }) {
  const max = listLimit?.max ?? 50;
  return z.object({
    entityRef: z.string().min(1).optional(),
    status: WORKFLOW_STATUS_SCHEMA.optional(),
    type: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(max).default(listLimit?.default ?? 20),
  });
}

/**
 * The served workflow shape: flow's public view plus the consumer's extension
 * fields. Exported so an OpenAPI layer can declare exactly what the factory
 * serves — the factory builds it from the same call.
 */
export function buildFlowWorkflowSchema<TExt extends z.ZodRawShape>(extensionShape?: TExt) {
  return PUBLIC_WORKFLOW_SCHEMA.extend(extensionShape ?? ({} as TExt));
}

/**
 * Build the generic read/control routes over a flow engine, as a mountable Hono
 * sub-app (`app.route('/workflows', createFlowWorkflowRoutes({ engine }))`):
 *
 * - `GET    /`            — list, newest first (`entityRef`/`status`/`type`/`limit` filters)
 * - `GET    /active`      — "anything in flight for this entity?" (trigger-button probe)
 * - `GET    /:id`         — one workflow with steps, public view
 * - `GET    /:id/status`  — light snapshot (cross-page progress polling)
 * - `POST   /:id/cancel`  — cancel (no-op ok on already-terminal workflows)
 * - `POST   /:id/resume`  — deliver an external event to a `waiting` step
 */
export function createFlowWorkflowRoutes<
  TExt extends z.ZodRawShape = Record<string, never>,
  TLoad = unknown,
>(options: CreateFlowWorkflowRoutesOptions<TExt, TLoad>) {
  const errorJson = createErrorJson(options.errorOverrides ?? {});
  const limitMax = options.listLimit?.max ?? 50;
  const ext = options.extendWorkflow;

  const resolveEngine = (ctx: unknown): MaybePromise<FlowEngineReader> =>
    typeof options.engine === 'function' ? options.engine(ctx) : options.engine;

  /** Returns the rejection response, or null to proceed. */
  async function deny(action: FlowRouteAction, c: Context) {
    if (!options.authorize) return null;
    const rejected = await options.authorize(action, c);
    if (!rejected) return null;
    return errorJson(c, rejected);
  }

  /**
   * The served shape, written as the intersection rather than derived from
   * `z.output<typeof buildFlowWorkflowSchema(ext?.schema)>`.
   *
   * That derivation looks tighter and is a **type-checker hazard**: with `TExt`
   * unresolved, `PUBLIC_WORKFLOW_SCHEMA.extend(shape)` cannot reduce, so the
   * whole unevaluated `$InferObjectOutput<…>` conditional — the entire zod
   * schema tree, `steps` array included — is carried into the `output` of every
   * route on this sub-app, and again into every `hc` client built over an app
   * that mounts them. TypeScript 7 absorbs it; **TypeScript 6 overflows its
   * call stack** on `hc<App>` (and on the bare `App` type), which is a hard
   * failure for any consumer pinned below 7 — a Vue app on `vue-tsc`, for one.
   * The intersection says the same thing (it is what the cast below always
   * asserted) and reduces immediately, so the emitted route types stay flat.
   * `buildFlowWorkflowSchema` is still exported and still describes exactly
   * this shape — `flow.test.ts` pins that equivalence so the two cannot drift.
   */
  type WorkflowView = PublicWorkflow & z.infer<z.ZodObject<TExt>>;

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
    }) as WorkflowView;

  const loadFor = async (workflows: WorkflowWithSteps[], ctx: unknown): Promise<TLoad | undefined> =>
    ext?.load ? await ext.load(workflows, ctx) : undefined;

  // ONE chain: Hono only accumulates route types across chained calls, and the
  // accumulated type is what `hc` reads. `/active` is registered before `/:id`
  // for readability only — Hono's router prefers the static segment either way.
  return new Hono()
    .get('/', octValidator('query', buildFlowListQuerySchema(options.listLimit)), async (c) => {
      const denied = await deny('list', c);
      if (denied) return denied;
      const query = c.req.valid('query');
      // Newest first (stores order by id DESC) — `entityRef` + `limit: 1` is a
      // client's "latest run for this entity" rehydration read.
      const engine = await resolveEngine(c);
      const listed = await engine.listWorkflows({
        entityRef: query.entityRef,
        status: query.status,
        type: query.type,
        limit: query.limit,
      });
      if (!listed.ok) return errorJson(c, listed.error);
      const loaded = await loadFor(listed.value, c);
      return c.json({ items: listed.value.map((workflow) => toView(workflow, loaded)) });
    })
    .get('/active', octValidator('query', SCHEMA_ACTIVE_QUERY), async (c) => {
      const denied = await deny('active', c);
      if (denied) return denied;
      const engine = await resolveEngine(c);
      const listed = await engine.listWorkflows({ entityRef: c.req.valid('query').entityRef, limit: limitMax });
      if (!listed.ok) return errorJson(c, listed.error);
      return c.json({
        active: listed.value.some((w) => w.status === 'pending' || w.status === 'running'),
      });
    })
    .get('/:id', octValidator('param', SCHEMA_ID_PARAM), async (c) => {
      const denied = await deny('get', c);
      if (denied) return denied;
      const engine = await resolveEngine(c);
      const status = await engine.getWorkflowStatus(c.req.valid('param').id);
      if (!status.ok) return errorJson(c, status.error);
      const loaded = await loadFor([status.value], c);
      return c.json(toView(status.value, loaded));
    })
    .get('/:id/status', octValidator('param', SCHEMA_ID_PARAM), async (c) => {
      const denied = await deny('status', c);
      if (denied) return denied;
      const engine = await resolveEngine(c);
      const status = await engine.getWorkflowStatus(c.req.valid('param').id);
      if (!status.ok) return errorJson(c, status.error);
      const { status: workflowStatus, totalSteps, completedSteps } = status.value;
      return c.json({ status: workflowStatus, totalSteps, completedSteps });
    })
    .post('/:id/cancel', octValidator('param', SCHEMA_ID_PARAM), async (c) => {
      const denied = await deny('cancel', c);
      if (denied) return denied;
      const engine = await resolveEngine(c);
      const cancelled = await engine.cancelWorkflow(c.req.valid('param').id);
      if (!cancelled.ok) return errorJson(c, cancelled.error);
      return c.json({ cancelled: true });
    })
    .post(
      '/:id/resume',
      octValidator('param', SCHEMA_ID_PARAM),
      octValidator('json', SCHEMA_RESUME_BODY),
      async (c) => {
        const denied = await deny('resume', c);
        if (denied) return denied;
        const engine = await resolveEngine(c);
        const body = c.req.valid('json');
        const resumed = await engine.resumeStep(c.req.valid('param').id, body.stepKey, body.payload);
        if (!resumed.ok) return errorJson(c, resumed.error);
        return c.json({ resumed: true });
      },
    );
}
