import { describe, it, expect, vi, beforeEach } from 'vitest';

const { connect, query, end, migrate, drizzle, ClientCtor } = vi.hoisted(() => {
  const connect = vi.fn(async () => undefined);
  const query = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const migrate = vi.fn(async () => undefined);
  const drizzle = vi.fn(() => ({ __db: true }));
  const ClientCtor = vi.fn(function () {
    return { connect, query, end };
  });
  return { connect, query, end, migrate, drizzle, ClientCtor };
});

vi.mock('pg', () => ({ Client: ClientCtor }));
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle }));

import { runMigrations } from './run-migrations.ts';

describe('runMigrations', () => {
  beforeEach(() => {
    connect.mockClear();
    query.mockClear();
    end.mockClear();
    migrate.mockClear();
    drizzle.mockClear();
    ClientCtor.mockClear();
  });

  it('connects, migrates with the given folder, and closes the client', async () => {
    await runMigrations({
      connectionString: 'postgres://x',
      migrationsFolder: '/abs/migrations',
    });

    expect(ClientCtor).toHaveBeenCalledWith({
      connectionString: 'postgres://x',
      ssl: undefined,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith(expect.anything(), {
      migrationsFolder: '/abs/migrations',
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('applies each sessionVar via set_config before migrating', async () => {
    await runMigrations({
      connectionString: 'postgres://x',
      migrationsFolder: '/abs/migrations',
      sessionVars: { 'app.system_mode': 'true', 'app.tenant_id': 't1' },
    });

    expect(query).toHaveBeenCalledWith('SELECT set_config($1, $2, false)', [
      'app.system_mode',
      'true',
    ]);
    expect(query).toHaveBeenCalledWith('SELECT set_config($1, $2, false)', [
      'app.tenant_id',
      't1',
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not run set_config when no sessionVars are given', async () => {
    await runMigrations({
      connectionString: 'postgres://x',
      migrationsFolder: '/abs/migrations',
    });

    expect(query).not.toHaveBeenCalled();
  });

  it('forwards ssl to the client', async () => {
    await runMigrations({
      connectionString: 'postgres://x',
      migrationsFolder: '/abs/migrations',
      ssl: { rejectUnauthorized: false },
    });

    expect(ClientCtor).toHaveBeenCalledWith({
      connectionString: 'postgres://x',
      ssl: { rejectUnauthorized: false },
    });
  });

  it('still closes the client and rethrows when migrate() fails', async () => {
    const boom = new Error('migrate boom');
    migrate.mockRejectedValueOnce(boom);

    await expect(
      runMigrations({
        connectionString: 'postgres://x',
        migrationsFolder: '/abs/migrations',
      }),
    ).rejects.toThrow('migrate boom');

    expect(end).toHaveBeenCalledTimes(1);
  });
});
