import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '../logger/index.ts';
import { runElysiaServer, type ListenableApp } from './run';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

/** Fake app recording what it was asked to listen on — no real port is bound. */
function fakeApp() {
  const listen = vi.fn();
  return { app: { listen } satisfies ListenableApp, listen };
}

describe('runElysiaServer', () => {
  it('listens on the loaded port and returns the app', async () => {
    const { app, listen } = fakeApp();

    const returned = await runElysiaServer({
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

    await runElysiaServer({ logger: silentLogger, load: async () => ({ app, port: 3001, logger }) });

    expect(info).toHaveBeenCalledWith('Server started', { url: 'http://localhost:3001' });
  });

  it('falls back to the bootstrap logger for the started-log when load returns none', async () => {
    const info = vi.fn();
    const logger: Logger = { ...silentLogger, info, child: () => logger };
    const { app } = fakeApp();

    await runElysiaServer({ logger, load: async () => ({ app, port: 3001 }) });

    expect(info).toHaveBeenCalledWith('Server started', { url: 'http://localhost:3001' });
  });

  it('onStarted replaces the default log and receives app/port/logger', async () => {
    const info = vi.fn();
    const logger: Logger = { ...silentLogger, info, child: () => logger };
    const onStarted = vi.fn();
    const { app } = fakeApp();

    await runElysiaServer({ logger: silentLogger, load: async () => ({ app, port: 3001, logger, onStarted }) });

    expect(onStarted).toHaveBeenCalledWith({ app, port: 3001, logger });
    expect(info).not.toHaveBeenCalled();
  });

  it('awaits an async onStarted before returning', async () => {
    const order: string[] = [];
    const { app } = fakeApp();

    await runElysiaServer({
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

    await runElysiaServer({
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

    await runElysiaServer({
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

    await runElysiaServer({ logger: silentLogger, load: async () => ({ app, port: 3001 }) });

    expect(on.mock.calls.some(([s]) => s === 'SIGTERM' || s === 'SIGINT')).toBe(false);
    on.mockRestore();
  });

  it('logs a bootstrap failure and exits 1 without listening', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error, child: () => logger };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const listen = vi.fn();

    await runElysiaServer({
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

    await runElysiaServer({ logger, load: async () => { throw 'string failure'; } });

    expect(error.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ message: 'string failure' });
    exit.mockRestore();
  });

  it('rethrows instead of exiting when exitProcess is false', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error, child: () => logger };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(runElysiaServer({
      logger,
      exitProcess: false,
      load: async () => { throw new Error('config invalid'); },
    })).rejects.toThrow('config invalid');

    expect(error).toHaveBeenCalledWith('Failed to start server', expect.any(Error));
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
