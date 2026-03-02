# @octabits-io/drizzle-test

Integration test utilities for Drizzle ORM with PostgreSQL via Testcontainers. Spins up a real Postgres container, runs migrations, and provides per-test isolation.

## Setup

**`vitest.config.ts`:**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './src/global-setup.ts',
  },
});
```

**`global-setup.ts`:**

```ts
import { createGlobalSetup } from '@octabits-io/drizzle-test';

const { setup, teardown } = createGlobalSetup({
  migrationsFolder: './drizzle/migrations',
  image: 'postgres:17-alpine', // optional, default
});

export { setup, teardown };
```

**Test file:**

```ts
import { setupTestDatabase, cleanupTestDatabase, resetDatabase } from '@octabits-io/drizzle-test';
import * as schema from './schema';

let db: Awaited<ReturnType<typeof setupTestDatabase<typeof schema>>>;

beforeAll(async () => {
  db = await setupTestDatabase({ schema });
});

afterAll(async () => {
  await cleanupTestDatabase();
});

beforeEach(async () => {
  await resetDatabase(db, [schema.users, schema.posts]); // truncate with CASCADE
});
```

## API

| Function | Description |
|---|---|
| `createGlobalSetup(opts)` | Creates Vitest `setup`/`teardown` hooks that start a Postgres container and run Drizzle migrations |
| `setupTestDatabase(opts)` | Connects to the container and returns a typed `NodePgDatabase<TSchema>` |
| `cleanupTestDatabase()` | Closes the connection pool |
| `resetDatabase(db, tables)` | Truncates tables with `RESTART IDENTITY CASCADE` |
