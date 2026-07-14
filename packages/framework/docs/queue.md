# @octabits-io/framework/queue

pg-boss-backed queue base layer for Octabits services. Provides a thin,
domain-agnostic foundation on top of [`pg-boss`](https://github.com/timgit/pg-boss):

- **`createBossManager`** — a lifecycle + monitoring facade over a single shared
  pg-boss instance (`start` / `stop` / `getJobById` / `getQueues` /
  `getQueueStats` / `cancelJob`). The logger is injected by the caller;
  maintenance/monitor intervals are configurable.
- **`createQueueDomain`** — a generic queue/worker/DLQ trio with Zod-validated
  payloads. Creates the dead-letter queue first, then the main queue with a
  `deadLetter` reference, and validates payloads on both enqueue and dequeue.
  Workers ack **per job** (pg-boss `perJobResults`): one failing job in a batch
  never fails or re-runs its batch-mates, a schema-invalid payload is routed
  straight to the DLQ (retrying can't fix it), and handlers see the real
  `retryCount`.
- **`defineQueue`** — a declarative layer over `createQueueDomain`. From a name,
  a Zod payload schema, a handler factory, and optional retry/expire config it
  generates enqueuer / worker / DLQ-handler factories. The dead-letter audit is
  factored out behind an injected sink (`onDlqAudit`) so **no table schema is
  baked in**, and partitioning stays generic via a `scopeKey` seam
  (`resolveScopeKey`) rather than any tenant vocabulary.
- Monitoring types + error factories (`JobDetails`, `QueueStats`, `JobState`,
  `createJobNotFoundError`, …).

There is **no domain coupling**: payload types are supplied by the consumer and
all methods return `Result<T, E>` from
[`@octabits-io/framework`](https://github.com/octabits-io/platform/tree/main/packages/foundation).
Enqueue-side validation failures return a structured
`PayloadValidationError` (with Zod issues); everything else returns
`QueueError` — `EnqueueError` is the exported union.

## Install

```bash
pnpm add @octabits-io/framework/queue pg-boss
```

`pg-boss` (v12), `@octabits-io/framework`, and `zod` (v4) are **peer
dependencies** you provide. pg-boss and foundation types (`PgBoss`, `Result`)
are part of this package's public API, so your app and this package must share
a single instance of each.

## Usage

```ts
import { z } from 'zod';
import {
  createBossManager,
  createQueueDomain,
  SCHEMA_SCOPED_JOB_PAYLOAD,
} from '@octabits-io/framework/queue';

// 1. One shared pg-boss lifecycle per process
const manager = createBossManager({
  connectionString: process.env.DATABASE_URL!,
  logger, // any @octabits-io/framework Logger (or structural equivalent)
});
await manager.start();

// 2. A typed, validated queue domain
const SCHEMA_EMAIL_JOB = SCHEMA_SCOPED_JOB_PAYLOAD.extend({
  to: z.string().email(),
});
type EmailJob = z.infer<typeof SCHEMA_EMAIL_JOB>;

const emailQueue = createQueueDomain<EmailJob>(
  { boss: manager.getBoss() },
  { name: 'email', dlq: 'email-dlq', schema: SCHEMA_EMAIL_JOB }
);

// 3. Enqueue + process
await emailQueue.enqueue({ scopeKey: 't1', to: 'guest@example.com' });

await emailQueue.startWorker(
  async (job) => {
    // job.data is validated + typed as EmailJob; job.retryCount is real
    await sendEmail(job.data);
    return { ok: true, value: undefined };
  },
  // batchSize: jobs fetched per poll, processed sequentially, acked per job
  { batchSize: 2, pollingIntervalSeconds: 2 }
);

// 4. Recurring jobs (payload validated like enqueue) + graceful shutdown
await emailQueue.schedule('email-digest', '0 8 * * *', { scopeKey: 't1', to: 'digest@example.com' });
await emailQueue.stop();
```

### Declarative queues with `defineQueue`

When a queue is a single payload type with a worker, an enqueuer, and a
dead-letter handler, `defineQueue` removes the boilerplate. It is a thin wrapper
over `createQueueDomain` — the enqueuer/worker keep the same validation and
per-job-acking semantics — plus a ready-made DLQ handler.

```ts
import { z } from 'zod';
import { defineQueue, SCHEMA_SCOPED_JOB_PAYLOAD } from '@octabits-io/framework/queue';

const SCHEMA_EMAIL_JOB = SCHEMA_SCOPED_JOB_PAYLOAD.extend({ to: z.string().email() });
type EmailJob = z.infer<typeof SCHEMA_EMAIL_JOB>;

const emailQueue = defineQueue<EmailJob>({
  name: 'email',
  schema: SCHEMA_EMAIL_JOB,
  // Handler factory — receives a scope factory + logger, returns a JobHandler.
  createHandler: ({ createSystemScope, logger }) => async (job) => {
    const scope = await createSystemScope(job.data.scopeKey);
    try {
      await scope.resolve('mailer').send(job.data);
      return { ok: true, value: undefined };
    } finally {
      await scope.dispose();
    }
  },
  config: { retryLimit: 5, retryDelay: 30, expireInSeconds: 120 }, // all optional
  // Bind the DLQ scope + populate the audit record's partition key. Omit for
  // unpartitioned queues — nothing tenant-specific is baked in.
  resolveScopeKey: (data) => data.scopeKey,
  // Audit sink — YOU decide how (and whether) to persist. No table schema here.
  onDlqAudit: async (scope, record) => {
    await scope.resolve('db').insert(jobAuditLog).values(record);
  },
});

// Wire the three factories against a shared pg-boss + your scope factory.
const boss = manager.getBoss();
const { enqueue, schedule } = emailQueue.createEnqueuer({ boss });
const worker = emailQueue.createWorker({ boss, logger });
const dlq = emailQueue.createDlqHandler({ boss, createSystemScope, logger });

await enqueue({ scopeKey: 't1', to: 'guest@example.com' });
await worker.startWorker({ createSystemScope });
await dlq.start();
```

The scope seam (`QueueScope` / `QueueScopeFactory`) is intentionally narrow —
`resolve(key)` + `dispose()` — and is structurally compatible with
foundation's IoC `DisposableServiceResolver` / `SystemScopeFactory`, so you can
pass a foundation scope factory directly. Each dead-lettered job is logged, run
through the optional `onDlq` hook, then handed to `onDlqAudit` with a
`DlqAuditRecord` (`queueName`, `jobId`, `jobType`, `status`, `errorMessage`,
`attemptCount`, `completedAt`, `scopeKey?`), discriminated on `validPayload`: when `true` the
record carries the typed `payload` and `attemptCount` is the exhausted retry
limit; when `false` (schema-invalid — dead-lettered on the first attempt,
without retry) it carries the raw value as `rawPayload: unknown` and
`attemptCount: 1`. A sink that throws is caught and logged, and the scope is
always disposed.

### Base payload types

`createQueueDomain<TPayload>` constrains `TPayload` only to
`BaseJobPayload` (`Record<string, unknown>`) — the base is not tied to any
partition scheme. Consumers can opt in to the recommended
`SCHEMA_SYSTEM_JOB_PAYLOAD` (`{ correlationId? }` — global/cron jobs, no sentinel
scope keys) or the partition-scoped `SCHEMA_SCOPED_JOB_PAYLOAD` (`{ scopeKey, correlationId? }`,
which extends it — `scopeKey` is e.g. a tenant id, and pairs with `defineQueue`'s
`resolveScopeKey` seam) and extend those, as shown above.

## License

MIT
