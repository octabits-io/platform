import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '../logger/index.ts';
import { registerGracefulShutdown, runServer, type ListenableApp } from './run';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

/** Fake app recording what it was asked to listen on — no real port is bound. */
function fakeApp() {
  const listen = vi.fn();
  return { app: { listen } satisfies ListenableApp, listen };
}

describe('runServer', () => {
  it('listens on the loaded port and returns the app', async () => {
    const { app, listen } = fakeApp();

    const returned = await runServer({
      logger: silentLogger,
      load: async () => ({ app, port: 3001 }),
    });

    expect(listen).toHaveBeenCalledWith(3001);
    expect(returned).toBe(app);
  });

  it('emits a default started-log via the loaded logger', async () => {
    const info = vi.fn();
    const logger: Logger = { ...silentLogger, info, child: () => logger };
    const { app } = fakeApp();

    await runServer({ logger: silentLogger, load: async () => ({ app, port: 3001, logger }) });

    expect(info).toHaveBeenCalledWith('Server started', { url: 'http://localhost:3001' });
  });

  it('falls back to the bootstrap logger for the started-log when load returns none', async () => {
    const info = vi.fn();
    const logger: Logger = { ...silentLogger, info, child: () => logger };
    const { app } = fakeApp();

    await runServer({ logger, load: async () => ({ app, port: 3001 }) });

    expect(info).toHaveBeenCalledWith('Server started', { url: 'http://localhost:3001' });
  });

  it('onStarted replaces the default log and receives app/port/logger', async () => {
    const info = vi.fn();
    const logger: Logger = { ...silentLogger, info, child: () => logger };
    const onStarted = vi.fn();
    const { app } = fakeApp();

    await runServer({ logger: silentLogger, load: async () => ({ app, port: 3001, logger, onStarted }) });

    expect(onStarted).toHaveBeenCalledWith({ app, port: 3001, logger });
    expect(info).not.toHaveBeenCalled();
  });

  it('awaits an async onStarted before returning', async () => {
    const order: string[] = [];
    const { app } = fakeApp();

    await runServer({
      logger: silentLogger,
      load: async () => ({
        app,
        port: 3001,
        onStarted: async () => {
          await Promise.resolve();
          order.push('started');
        },
      }),
    });
    order.push('returned');

    expect(order).toEqual(['started', 'returned']);
  });

  it('listens before the started hook runs', async () => {
    const order: string[] = [];
    const app: ListenableApp = { listen: () => { order.push('listen'); } };

    await runServer({
      logger: silentLogger,
      load: async () => ({ app, port: 3001, onStarted: () => { order.push('onStarted'); } }),
    });

    expect(order).toEqual(['listen', 'onStarted']);
  });

  it('wires graceful shutdown to the returned stop', async () => {
    const stop = vi.fn(async () => {});
    const on = vi.spyOn(process, 'on');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { app } = fakeApp();

    await runServer({
      logger: silentLogger,
      load: async () => ({ app, port: 3001, stop }),
      shutdown: { signals: ['SIGUSR2'] },
    });

    const handler = on.mock.calls.find(([s]) => s === 'SIGUSR2')?.[1] as () => void;
    expect(handler).toBeTypeOf('function');
    handler();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('SIGUSR2'));

    on.mockRestore(); exit.mockRestore();
  });

  it('registers no signal handlers when load returns no stop', async () => {
    const on = vi.spyOn(process, 'on');
    const { app } = fakeApp();

    await runServer({ logger: silentLogger, load: async () => ({ app, port: 3001 }) });

    expect(on.mock.calls.some(([s]) => s === 'SIGTERM' || s === 'SIGINT')).toBe(false);
    on.mockRestore();
  });

  it('logs a bootstrap failure and exits 1 without listening', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error, child: () => logger };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const listen = vi.fn();

    await runServer({
      logger,
      load: async () => { throw new Error('vault unreachable'); },
    });

    expect(error).toHaveBeenCalledWith('Failed to start server', expect.any(Error));
    expect(error.mock.calls[0]?.[1]).toMatchObject({ message: 'vault unreachable' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(listen).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('wraps a non-Error throw for the logger', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error, child: () => logger };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await runServer({ logger, load: async () => { throw 'string failure'; } });

    expect(error.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ message: 'string failure' });
    exit.mockRestore();
  });

  it('rethrows instead of exiting when exitProcess is false', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error, child: () => logger };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(runServer({
      logger,
      exitProcess: false,
      load: async () => { throw new Error('config invalid'); },
    })).rejects.toThrow('config invalid');

    expect(error).toHaveBeenCalledWith('Failed to start server', expect.any(Error));
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});

/**
 * Signal handling: the tail of `main()` in every service. Each test uses its
 * own signal name and removes its listener, so the suite never leaves a handler
 * that would exit the test runner on a later signal.
 */
describe('registerGracefulShutdown', () => {
  /** Run one shutdown cycle on an isolated signal, with process.exit stubbed. */
  async function shutdownOn(
    signal: NodeJS.Signals,
    options: { stop: (signal: string) => Promise<void>; timeoutMs?: number },
  ) {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as never);
    const exitCodes: number[] = [];

    // An earlier test in this file leaves a runServer-installed handler on its
    // own signal; clear first so a stale listener cannot double-fire this one.
    process.removeAllListeners(signal);
    registerGracefulShutdown({
      logger: silentLogger,
      stop: options.stop,
      signals: [signal],
      ...(options.timeoutMs != null && { timeoutMs: options.timeoutMs }),
    });

    process.emit(signal);
    // Let the async shutdown body run to completion.
    await vi.waitFor(() => expect(exitCodes.length).toBeGreaterThan(0));

    process.removeAllListeners(signal);
    exit.mockRestore();
    return exitCodes;
  }

  it('runs stop and exits 0 on the signal', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);

    const codes = await shutdownOn('SIGCONT', { stop });

    expect(stop).toHaveBeenCalledWith('SIGCONT');
    expect(codes).toEqual([0]);
  });

  it('exits 1 when stop rejects, rather than leaving the process up', async () => {
    const codes = await shutdownOn('SIGHUP', { stop: () => Promise.reject(new Error('drain failed')) });

    expect(codes).toEqual([1]);
  });

  it('forces exit 1 when stop outlives the timeout', async () => {
    // The watchdog is the reason a wedged connection pool cannot hold a
    // rolling deploy open forever.
    const codes = await shutdownOn('SIGWINCH', { stop: () => new Promise(() => {}), timeoutMs: 10 });

    expect(codes).toEqual([1]);
  });

  it('registers every requested signal', async () => {
    process.removeAllListeners('SIGCONT');
    process.removeAllListeners('SIGWINCH');
    registerGracefulShutdown({
      logger: silentLogger,
      stop: async () => {},
      signals: ['SIGCONT', 'SIGWINCH'],
    });

    expect(process.listenerCount('SIGCONT')).toBe(1);
    expect(process.listenerCount('SIGWINCH')).toBe(1);
    process.removeAllListeners('SIGCONT');
    process.removeAllListeners('SIGWINCH');
  });
});
