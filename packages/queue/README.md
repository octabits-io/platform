# @octabits-io/queue

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
- Monitoring types + error factories (`JobDetails`, `QueueStats`, `JobState`,
  `createJobNotFoundError`, …).

There is **no domain coupling**: payload types are supplied by the consumer and
all methods return `Result<T, E>` from
[`@octabits-io/foundation`](https://github.com/octabits-io/platform/tree/main/packages/foundation).
Enqueue-side validation failures return a structured
`PayloadValidationError` (with Zod issues); everything else returns
`QueueError` — `EnqueueError` is the exported union.

## Install

```bash
pnpm add @octabits-io/queue pg-boss
```

`pg-boss` (v12), `@octabits-io/foundation`, and `zod` (v4) are **peer
dependencies** you provide. pg-boss and foundation types (`PgBoss`, `Result`)
are part of this package's public API, so your app and this package must share
a single instance of each.

## Usage

```ts
import { z } from 'zod';
import {
  createBossManager,
  createQueueDomain,
  SCHEMA_TENANT_JOB_PAYLOAD,
} from '@octabits-io/queue';

// 1. One shared pg-boss lifecycle per process
const manager = createBossManager({
  connectionString: process.env.DATABASE_URL!,
  logger, // any @octabits-io/foundation Logger (or structural equivalent)
});
await manager.start();

// 2. A typed, validated queue domain
const SCHEMA_EMAIL_JOB = SCHEMA_TENANT_JOB_PAYLOAD.extend({
  to: z.string().email(),
});
type EmailJob = z.infer<typeof SCHEMA_EMAIL_JOB>;

const emailQueue = createQueueDomain<EmailJob>(
  { boss: manager.getBoss() },
  { name: 'email', dlq: 'email-dlq', schema: SCHEMA_EMAIL_JOB }
);

// 3. Enqueue + process
await emailQueue.enqueue({ tenantId: 't1', to: 'guest@example.com' });

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
await emailQueue.schedule('email-digest', '0 8 * * *', { tenantId: 't1', to: 'digest@example.com' });
await emailQueue.stop();
```

### Base payload types

`createQueueDomain<TPayload>` constrains `TPayload` only to
`BaseJobPayload` (`Record<string, unknown>`) — the base is not tied to
multi-tenancy. Multi-tenant consumers can opt in to the recommended
`SCHEMA_SYSTEM_JOB_PAYLOAD` (`{ correlationId? }` — global/cron jobs, no sentinel
tenant ids) or the multi-tenant `SCHEMA_TENANT_JOB_PAYLOAD` (`{ tenantId, correlationId? }`,
which extends it) and extend those, as
shown above.

## License

MIT
