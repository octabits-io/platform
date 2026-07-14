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

  it('prints nothing when the logger is disabled (default), even on failure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runMigrations({ connectionString: 'postgres://x', migrationsFolder: '/abs/m' });

      migrate.mockRejectedValueOnce(new Error('boom'));
      await expect(
        runMigrations({ connectionString: 'postgres://x', migrationsFolder: '/abs/m' }),
      ).rejects.toThrow('boom');

      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('routes progress through an injected structured logger', async () => {
    const info = vi.fn();
    const error = vi.fn();
    await runMigrations({
      connectionString: 'postgres://x',
      migrationsFolder: '/abs/migrations',
      logger: { info, error },
    });

    expect(info).toHaveBeenCalledWith('Running database migrations', {
      migrationsFolder: '/abs/migrations',
    });
    expect(info).toHaveBeenCalledWith('Database migrations completed successfully');
    expect(error).not.toHaveBeenCalled();
  });

  it('reports failures through logger.error and still rethrows', async () => {
    const info = vi.fn();
    const error = vi.fn();
    const boom = new Error('migrate boom');
    migrate.mockRejectedValueOnce(boom);

    await expect(
      runMigrations({
        connectionString: 'postgres://x',
        migrationsFolder: '/abs/migrations',
        logger: { info, error },
      }),
    ).rejects.toThrow('migrate boom');

    expect(error).toHaveBeenCalledWith('Migration failed', boom);
  });

  it('logger: true falls back to plain console output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runMigrations({
        connectionString: 'postgres://x',
        migrationsFolder: '/abs/migrations',
        logger: true,
      });
      expect(log).toHaveBeenCalledWith('Running database migrations', {
        migrationsFolder: '/abs/migrations',
      });
      expect(log).toHaveBeenCalledWith('Database migrations completed successfully');
    } finally {
      log.mockRestore();
    }
  });
});
