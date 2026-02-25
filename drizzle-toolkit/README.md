# @octabits-io/drizzle-toolkit

Shared Drizzle ORM utilities: database error handling, pagination, and a DAG-based workflow engine backed by PostgreSQL.

## Modules

### `@octabits-io/drizzle-toolkit/db`

Database error handling and pagination helpers.

```ts
import {
  withDbErrorHandling,
  handleTransactionError,
  TransactionRollbackError,
  normalizePaginationLimit,
} from '@octabits-io/drizzle-toolkit/db';

// Wrap DB operations — catches PG errors and returns Result<T, E | OctDatabaseError>
const result = await withDbErrorHandling(async () => {
  await db.insert(users).values({ email });
  return { ok: true, value: undefined };
});
// result.error.code → 'unique_violation' | 'foreign_key_violation' | ...

// Inside transactions — preserve typed errors through rollback
try {
  await db.transaction(async (tx) => {
    const result = await paymentService.create(tenantId, params, tx);
    if (!result.ok) throw new TransactionRollbackError(result.error);
  });
} catch (error) {
  return handleTransactionError(error); // preserves typed error or maps PG error
}

// Pagination: limit=-1 → capped at 10,000
const dbLimit = normalizePaginationLimit(params.limit);
```

---

### `@octabits-io/drizzle-toolkit/workflow`

DAG-based workflow engine with typed steps, dependency resolution, and queue integration.

**Define type-safe steps with Zod validation:**

```ts
import { defineStep, buildTypedWorkflow } from '@octabits-io/drizzle-toolkit/workflow';
import { z } from 'zod';

const analyzeImages = defineStep({
  type: 'ai:analyze-images',
  workflowInputSchema: z.object({ listingId: z.number() }),
  outputSchema: z.object({ tags: z.array(z.string()) }),
  handler: async (ctx) => {
    // ctx.workflowInput is typed, ctx.deps has parsed dependency outputs
    return { tags: ['modern', 'spacious'] };
  },
});

const generateDescription = defineStep({
  type: 'ai:generate-description',
  workflowInputSchema: z.object({ listingId: z.number() }),
  outputSchema: z.object({ description: z.string() }),
  dependencies: { 'analyze-images': analyzeImages },
  handler: async (ctx) => {
    const tags = ctx.deps['analyze-images'].tags; // fully typed
    return { description: `A ${tags.join(', ')} property` };
  },
});
```

**Build and run a workflow:**

```ts
const enrichmentWorkflow = buildTypedWorkflow({
  type: 'listing-enrichment',
  inputSchema: z.object({ listingId: z.number() }),
  steps: {
    'analyze-images': analyzeImages,
    'generate-description': generateDescription,
  },
});

// Register handlers at startup
enrichmentWorkflow.register(stepHandlerRegistry);

// Start a workflow (steps with no deps are enqueued immediately)
const result = await engine.start(enrichmentWorkflow, { listingId: 42 });
```

**Engine API:**

```ts
import { createWorkflowEngine } from '@octabits-io/drizzle-toolkit/workflow';

const engine = createWorkflowEngine({
  db, tables: { workflow: workflowTable, workflowStep: workflowStepTable },
  logger, stepHandlerRegistry, enqueueStepJob, tenantId,
});

await engine.startWorkflow(definition, input);
await engine.executeStep(workflowId, stepId);  // called by queue worker
await engine.cancelWorkflow(workflowId);
await engine.getWorkflowStatus(workflowId);
await engine.listWorkflows({ status: 'running', type: 'listing-enrichment' });
```

**Queue types** (`@octabits-io/drizzle-toolkit/workflow` also exports queue primitives):

`QueueDomain`, `QueueDomainConfig`, `JobHandler`, `JobContext`, `QueuedJob`, `QueueError`

**Database tables:**

Provides `workflowTable`, `workflowStepTable` Drizzle table definitions and raw `WORKFLOW_MIGRATION_SQL`.
