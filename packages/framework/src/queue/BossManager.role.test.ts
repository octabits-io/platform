/**
 * `role` decides how much of pg-boss's background machinery a process brings
 * up. Those flags are constructor-only (pg-boss's `start()` takes no options)
 * and land in a private field, so the only way to assert them is to capture
 * what the constructor was handed — hence the module mock, and hence this
 * file being separate from `index.test.ts`, which needs the real class.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConstructorOptions } from 'pg-boss';

const constructorOptions: ConstructorOptions[] = [];

vi.mock('pg-boss', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg-boss')>();
  class SpyPgBoss extends actual.PgBoss {
    constructor(options: ConstructorOptions) {
      super(options);
      constructorOptions.push(options);
    }
  }
  return { ...actual, PgBoss: SpyPgBoss };
});

const { createBossManager } = await import('./BossManager.ts');

type BossManagerConfig = Parameters<typeof createBossManager>[0];

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};

function optionsWith(config: Partial<BossManagerConfig> = {}): ConstructorOptions {
  createBossManager({
    connectionString: 'postgres://user:pass@localhost:5432/db',
    logger,
    ...config,
  });
  return constructorOptions.at(-1)!;
}

function optionsFor(role?: 'full' | 'producer'): ConstructorOptions {
  return optionsWith(role ? { role } : {});
}

describe('createBossManager — producer start failure', () => {
  beforeEach(() => {
    constructorOptions.length = 0;
  });

  function managerWithFailingStart(role: 'full' | 'producer') {
    const manager = createBossManager({
      connectionString: 'postgres://user:pass@localhost:5432/db',
      logger,
      role,
    });
    vi.spyOn(manager.getBoss(), 'start').mockRejectedValue(
      new Error('pg-boss is not installed'),
    );
    return manager;
  }

  it("tells a producer what to do about a schema it is not allowed to install", async () => {
    // pg-boss's own message describes a state a producer cannot fix, and reads
    // like a bug rather than a deployment-order problem.
    await expect(managerWithFailingStart('producer').start()).rejects.toThrow(
      /never installs or migrates the schema/,
    );
  });

  it('keeps the original failure as the cause', async () => {
    const error = await managerWithFailingStart('producer').start().catch((e: unknown) => e);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe('pg-boss is not installed');
  });

  it('leaves a full-role failure untouched', async () => {
    await expect(managerWithFailingStart('full').start()).rejects.toThrow(
      /^pg-boss is not installed$/,
    );
  });
});

describe('createBossManager — role', () => {
  beforeEach(() => {
    constructorOptions.length = 0;
  });

  it('defaults to the full role: pg-boss keeps its own defaults for supervision, scheduling and migration', () => {
    const options = optionsFor();

    // Asserted as "not disabled" rather than "=== true": pg-boss owns these
    // defaults, and a manager that says nothing must keep inheriting them.
    expect(options.supervise).toBeUndefined();
    expect(options.schedule).toBeUndefined();
    expect(options.migrate).toBeUndefined();
  });

  it('an explicit full role is identical to the default', () => {
    expect(optionsFor('full')).toEqual(optionsFor());
  });

  it('the producer role disables supervision, scheduling and migration', () => {
    const options = optionsFor('producer');

    expect(options.supervise).toBe(false);
    expect(options.schedule).toBe(false);
    // The load-bearing one: an ephemeral producer must never run DDL against a
    // schema the long-lived processes own. `migrate: false` turns pg-boss's
    // start into a *check* that throws on a missing or outdated installation.
    expect(options.migrate).toBe(false);
  });

  it('the producer role changes nothing else — connection, schema and intervals are untouched', () => {
    const full = optionsFor('full');
    const producer = optionsFor('producer');

    const { supervise: _s, schedule: _c, migrate: _m, useListenNotify: _l, ...rest } = producer;
    const { useListenNotify: _fl, ...fullRest } = full;
    expect(rest).toEqual(fullRest);
  });

  it('the full role listens for NOTIFY wakes; the producer role does not (it runs no workers)', () => {
    expect(optionsFor('full').useListenNotify).toBe(true);
    expect(optionsFor('producer').useListenNotify).toBe(false);
  });
});

describe('createBossManager — reindex', () => {
  beforeEach(() => {
    constructorOptions.length = 0;
  });

  it('says nothing by default, so pg-boss keeps its own reindex defaults', () => {
    // Asserted as absence, not `=== true`: pg-boss owns the default (rebuild
    // bloated indexes since 12.29), and a manager that says nothing must keep
    // inheriting whatever that default becomes.
    expect('reindex' in optionsWith()).toBe(false);
    expect('reindexIntervalSeconds' in optionsWith()).toBe(false);
  });

  it('passes an explicit opt-out through', () => {
    expect(optionsWith({ reindex: false }).reindex).toBe(false);
  });

  it('passes a threshold object and the interval through', () => {
    const options = optionsWith({
      reindex: { minPages: 512, minSizeRatio: 8 },
      reindexIntervalSeconds: 3600,
    });

    expect(options.reindex).toEqual({ minPages: 512, minSizeRatio: 8 });
    expect(options.reindexIntervalSeconds).toBe(3600);
  });

  it('never spreads an undefined key — pg-boss reads these with `in`', () => {
    // `reindex: undefined` is not "unset" to pg-boss: its config assert sees
    // the key, finds a non-boolean/non-object value and throws. Constructing
    // with the key explicitly undefined must therefore still be a clean start.
    const options = optionsWith({ reindex: undefined, reindexIntervalSeconds: undefined });

    expect('reindex' in options).toBe(false);
    expect('reindexIntervalSeconds' in options).toBe(false);
  });

  it('applies to the producer role too, where pg-boss simply never acts on it', () => {
    // A producer supervises nothing, so the flag is inert — but the two roles
    // must still differ in exactly the PRODUCER_OPTIONS flags and nothing else.
    expect(optionsWith({ role: 'producer', reindex: false }).reindex).toBe(false);
  });
});

describe('createBossManager — database source', () => {
  beforeEach(() => {
    constructorOptions.length = 0;
  });

  it('passes a Db adapter and backend profile through, and hands pg-boss no connection string', () => {
    // An embedded database (PGlite) or a shared ORM connection: pg-boss runs
    // every statement through the adapter and opens no pool of its own.
    const db = { executeSql: async () => ({ rows: [] }) };
    const options = optionsWith({ connectionString: undefined, db, backend: 'pglite' });

    expect(options.db).toBe(db);
    expect(options.backend).toBe('pglite');
    expect('connectionString' in options).toBe(false);
  });

  it('never spreads an undefined backend — pg-boss reads it with `in`', () => {
    expect('backend' in optionsWith()).toBe(false);
    expect('db' in optionsWith()).toBe(false);
  });

  it('demands exactly one of connectionString and db', () => {
    const db = { executeSql: async () => ({ rows: [] }) };
    expect(() => optionsWith({ connectionString: undefined })).toThrow(/exactly one of/);
    expect(() => optionsWith({ db })).toThrow(/exactly one of/);
  });
});
