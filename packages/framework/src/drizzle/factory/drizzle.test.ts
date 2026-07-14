import { describe, it, expect, vi } from 'vitest';

const { setTypeParser, drizzleMock } = vi.hoisted(() => ({
  setTypeParser: vi.fn(),
  drizzleMock: vi.fn(() => ({})),
}));

vi.mock('pg', () => ({
  types: { setTypeParser, builtins: { INT8: 20 } },
}));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: drizzleMock }));

import { createDrizzle, createDrizzleFromClient } from './drizzle.ts';
import type { Pool, PoolClient } from 'pg';

const schema = { users: { name: 'users' } };

describe('int8 type parser registration', () => {
  it('does not mutate pg globals at module load; registers once, idempotently, on factory use', () => {
    // Import alone (already happened above) must not touch pg's parser registry.
    expect(setTypeParser).not.toHaveBeenCalled();

    createDrizzle(schema, { pool: {} as Pool });
    expect(setTypeParser).toHaveBeenCalledTimes(1);
    expect(setTypeParser).toHaveBeenCalledWith(20, Number);

    // Repeat factory calls (either entry point) never re-register.
    createDrizzle(schema, { pool: {} as Pool });
    createDrizzleFromClient(schema, { client: {} as PoolClient });
    expect(setTypeParser).toHaveBeenCalledTimes(1);
  });
});
