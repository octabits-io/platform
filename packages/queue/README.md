# @octabits-io/queue

pg-boss-backed queue base layer for Octabits services. Provides a thin,
domain-agnostic foundation on top of [`pg-boss`](https://github.com/timgit/pg-boss):

- **`createBossManager`** — a lifecycle + monitoring facade over a single shared
  pg-boss instance (`start` / `stop` / `getJobById` / `getQueues` /
  `getQueueStats` / `cancelJob`). The logger is injected by the caller.
- **`createQueueDomain`** — a generic queue/worker/DLQ trio with Zod-validated
  payloads. Creates the dead-letter queue first, then the main queue with a
  `deadLetter` reference, and validates payloads on both enqueue and dequeue.
- Monitoring types + error factories (`JobDetails`, `QueueStats`, `JobState`,
  `createJobNotFoundError`, …).

There is **no domain coupling**: payload types are supplied by the consumer and
all methods return `Result<T, E>` from
[`@octabits-io/foundation`](https://github.com/octabits-io/platform/tree/main/packages/foundation).

## Install

```bash
pnpm add @octabits-io/queue pg-boss
```

`pg-boss` is a direct runtime dependency; `zod` (v4) is a peer dependency you
provide.

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

await emailQueue.startWorker(async (job) => {
  // job.data is validated + typed as EmailJob
  await sendEmail(job.data);
  return { ok: true, value: undefined };
});
```

### Base payload types

`createQueueDomain<TPayload>` constrains `TPayload` only to
`BaseJobPayload` (`Record<string, unknown>`) — the base is not tied to
multi-tenancy. Multi-tenant consumers can opt in to the recommended
`SCHEMA_TENANT_JOB_PAYLOAD` (`{ tenantId, correlationId? }`) and extend it, as
shown above.

## License

MIT
