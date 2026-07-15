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
 * Consumer-specific wire fields ride on the `extendWorkflow` seam, which takes
 * the schema fragment and its projection *together* so the declared response
 * type and the served value cannot drift:
 *
 * ```ts
 * new Elysia({ prefix: '/ai' }).use(createFlowWorkflowRoutes({
 *   engine,
 *   errorOverrides: { ai_quota_exceeded: 429 },
 *   extendWorkflow: {
 *     schema: { appliedAt: z.string().nullable() },
 *     project: (wf) => ({ appliedAt: (wf.metadata?.appliedAt as string | undefined) ?? null }),
 *   },
 * }))
 * ```
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
  type PublicWorkflow,
  type WorkflowStatus,
  type WorkflowWithSteps,
} from '@octabits-io/flow';
import { createErrorMapper, type ErrorStatusOverrides } from './errors.ts';
import { errorResponses } from './responses.ts';

/** Structural result — matches flow's `Result` without naming it. */
type FlowResult<T> = { ok: true; value: T } | { ok: false; error: { key: string; message: string } };

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
 * Consumer fields added to the wire shape. `schema` extends
 * `PUBLIC_WORKFLOW_SCHEMA`; `project` produces the matching values, spread
 * over `toPublicWorkflow(...)`. One seam for both keeps schema and value in
 * lockstep.
 */
export interface WorkflowViewExtension<TExt extends z.ZodRawShape> {
  schema: TExt;
  project: (workflow: WorkflowWithSteps) => z.infer<z.ZodObject<TExt>>;
}

export interface CreateFlowWorkflowRoutesOptions<
  TExt extends z.ZodRawShape,
  TPrefix extends string = '/workflows',
> {
  engine: FlowEngineReader;
  /**
   * Route prefix. Default `'/workflows'`. Typed as a literal on purpose — a
   * plain `string` widens Elysia's BasePath and collapses every route key in
   * the emitted type to an index signature, which makes the routes invisible
   * to Eden.
   */
  prefix?: TPrefix;
  /** OpenAPI tags. Default `['Workflows']`. */
  tags?: string[];
  /** Domain key → status overrides merged into the framework conventions (e.g. `{ ai_quota_exceeded: 429 }`). */
  errorOverrides?: ErrorStatusOverrides;
  /** List-route page size bounds. Default `{ max: 50, default: 20 }`. */
  listLimit?: { max?: number; default?: number };
  /** Consumer fields on the workflow wire shape (see {@link WorkflowViewExtension}). */
  extendWorkflow?: WorkflowViewExtension<TExt>;
}

const SCHEMA_STATUS_SNAPSHOT = z.object({
  status: WORKFLOW_STATUS_SCHEMA,
  totalSteps: z.number().int(),
  completedSteps: z.number().int(),
});

/**
 * Build the generic read/control routes over a flow engine:
 *
 * - `GET    <prefix>`             — list, newest first (`entityRef`/`status`/`limit` filters)
 * - `GET    <prefix>/active`      — "anything in flight for this entity?" (trigger-button probe)
 * - `GET    <prefix>/:id`         — one workflow with steps, public view
 * - `GET    <prefix>/:id/status`  — light snapshot (cross-page progress polling)
 * - `POST   <prefix>/:id/cancel`  — cancel (no-op ok on already-terminal workflows)
 * - `POST   <prefix>/:id/resume`  — deliver an external event to a `waiting` step
 */
export function createFlowWorkflowRoutes<
  TExt extends z.ZodRawShape = Record<string, never>,
  TPrefix extends string = '/workflows',
>(options: CreateFlowWorkflowRoutesOptions<TExt, TPrefix>) {
  const { engine } = options;
  const { statusErrorWithSet } = createErrorMapper(options.errorOverrides ?? {});
  const limitMax = options.listLimit?.max ?? 50;
  const limitDefault = options.listLimit?.default ?? 20;

  const workflowSchema = PUBLIC_WORKFLOW_SCHEMA.extend(
    options.extendWorkflow?.schema ?? ({} as TExt),
  );
  // Typed off the schema value so the handler return type and the declared
  // `response` schema unify for Elysia (and therefore for Eden).
  type WorkflowView = z.output<typeof workflowSchema>;
  const toView = (workflow: WorkflowWithSteps): WorkflowView =>
    ({
      ...toPublicWorkflow(workflow),
      ...(options.extendWorkflow?.project(workflow) ?? {}),
    }) as PublicWorkflow & z.infer<z.ZodObject<TExt>> as WorkflowView;

  return new Elysia({
    prefix: (options.prefix ?? '/workflows') as TPrefix,
    tags: options.tags ?? ['Workflows'],
  })
    .get(
      // '' (not '/'): under a prefixed parent, prefix + '/' only matches the
      // trailing-slash form; '' matches the exact prefix path in both layouts.
      '',
      async ({ query, set }) => {
        // Newest first (stores order by id DESC) — `entityRef` + `limit: 1` is
        // a client's "latest run for this entity" rehydration read.
        const listed = await engine.listWorkflows({
          entityRef: query.entityRef,
          status: query.status,
          type: query.type,
          limit: query.limit,
        });
        if (!listed.ok) return statusErrorWithSet(set, listed.error);
        return { items: listed.value.map(toView) };
      },
      {
        query: z.object({
          entityRef: z.string().min(1).optional(),
          status: WORKFLOW_STATUS_SCHEMA.optional(),
          type: z.string().min(1).optional(),
          limit: z.coerce.number().int().positive().max(limitMax).default(limitDefault),
        }),
        response: { 200: z.object({ items: z.array(workflowSchema) }), ...errorResponses(400, 429, 500) },
        detail: { summary: 'List workflows, newest first' },
      },
    )
    .get(
      '/active',
      async ({ query, set }) => {
        const listed = await engine.listWorkflows({ entityRef: query.entityRef, limit: limitMax });
        if (!listed.ok) return statusErrorWithSet(set, listed.error);
        return { active: listed.value.some((w) => w.status === 'pending' || w.status === 'running') };
      },
      {
        query: z.object({ entityRef: z.string().min(1) }),
        response: { 200: z.object({ active: z.boolean() }), ...errorResponses(400, 429, 500) },
        detail: { summary: 'Whether a workflow is in flight for an entity' },
      },
    )
    .get(
      '/:id',
      async ({ params, set }) => {
        const status = await engine.getWorkflowStatus(params.id);
        // `as never` on both branches: while TExt is generic, the 200 schema's
        // output type is an unresolved conditional, so TS can prove neither
        // branch a member of Elysia's response union (the `{ items }`-wrapped
        // list route unifies fine). Client/Eden types are unaffected — they
        // derive from the `response` schema map, not the handler return.
        if (!status.ok) return statusErrorWithSet(set, status.error) as never;
        return toView(status.value) as never;
      },
      {
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: { 200: workflowSchema, ...errorResponses(400, 404, 429, 500) },
        detail: { summary: 'Get one workflow with its steps' },
      },
    )
    .get(
      '/:id/status',
      async ({ params, set }) => {
        const status = await engine.getWorkflowStatus(params.id);
        if (!status.ok) return statusErrorWithSet(set, status.error);
        const { status: workflowStatus, totalSteps, completedSteps } = status.value;
        return { status: workflowStatus, totalSteps, completedSteps };
      },
      {
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: { 200: SCHEMA_STATUS_SNAPSHOT, ...errorResponses(400, 404, 429, 500) },
        detail: { summary: 'Get a workflow status snapshot' },
      },
    )
    .post(
      '/:id/cancel',
      async ({ params, set }) => {
        const cancelled = await engine.cancelWorkflow(params.id);
        if (!cancelled.ok) return statusErrorWithSet(set, cancelled.error);
        return { cancelled: true };
      },
      {
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: { 200: z.object({ cancelled: z.boolean() }), ...errorResponses(400, 404, 429, 500) },
        detail: { summary: 'Cancel a running workflow' },
      },
    )
    .post(
      '/:id/resume',
      async ({ params, body, set }) => {
        const resumed = await engine.resumeStep(params.id, body.stepKey, body.payload);
        if (!resumed.ok) return statusErrorWithSet(set, resumed.error);
        return { resumed: true };
      },
      {
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: z.object({
          stepKey: z.string().min(1),
          payload: z.record(z.string(), z.unknown()).optional(),
        }),
        response: { 200: z.object({ resumed: z.boolean() }), ...errorResponses(400, 404, 409, 429, 500) },
        detail: { summary: "Deliver an external event to a waiting step" },
      },
    );
}
