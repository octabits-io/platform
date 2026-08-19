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

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};

function optionsFor(role?: 'full' | 'producer'): ConstructorOptions {
  createBossManager({
    connectionString: 'postgres://user:pass@localhost:5432/db',
    logger,
    ...(role ? { role } : {}),
  });
  return constructorOptions.at(-1)!;
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

    const { supervise: _s, schedule: _c, migrate: _m, ...rest } = producer;
    expect(rest).toEqual(full);
  });
});
