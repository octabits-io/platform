# @octabits-io/drizzle-toolkit

Shared Drizzle ORM utilities: database error handling and pagination helpers.

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

> **Note:** The former `./workflow` module (DAG workflow engine) has been superseded by
> [`@octabits-io/flow`](../flow) — a standalone durable workflow engine with a Postgres
> store and pg-boss dispatcher. Use that package instead.
