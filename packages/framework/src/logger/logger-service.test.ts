import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLoggerService } from './logger-service.ts';

const ENDPOINT = 'http://collector.test:4318/v1/logs';

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  consoleSpies = [
    vi.spyOn(console, 'debug').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

/** `fetch` stub resolving 200, capturing the exported payloads. */
function stubFetch() {
  return vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
}

function exportedRecords(fetchImpl: typeof fetch): Array<Record<string, unknown>> {
  const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls.flatMap((call: unknown[]) => {
    const payload = JSON.parse(String((call[1] as RequestInit).body));
    return payload.resourceLogs.flatMap((rl: { scopeLogs: Array<{ logRecords: unknown[] }> }) =>
      rl.scopeLogs.flatMap((sl) => sl.logRecords)
    );
  }) as Array<Record<string, unknown>>;
}

describe('createLoggerService', () => {
  it('writes JSON records to the console outside development', () => {
    const { logger } = createLoggerService({
      config: { serviceName: 'api', serviceVersion: '1.0.0', environment: 'production' },
    });

    logger.info('Server started', { port: 3000 });

    const line = vi.mocked(console.info).mock.calls[0]![0] as string;
    expect(JSON.parse(line)).toMatchObject({
      severityText: 'INFO',
      body: 'Server started',
      attributes: { port: 3000 },
      resource: {
        'service.name': 'api',
        'service.version': '1.0.0',
        'deployment.environment': 'production',
      },
    });
  });

  it('writes human-readable lines in development', () => {
    const { logger } = createLoggerService({
      config: { serviceName: 'api', environment: 'development' },
    });

    logger.info('Processing', { requestId: 'abc123' });

    const line = vi.mocked(console.info).mock.calls[0]![0] as string;
    expect(line).toContain('[INFO ] [api] Processing {"requestId":"abc123"}');
    expect(() => JSON.parse(line)).toThrow();
  });

  it('prints the stack below the message in development, not inline', () => {
    const { logger } = createLoggerService({
      config: { serviceName: 'api', environment: 'development' },
    });

    const error = new Error('boom');
    error.stack = 'Error: boom\n    at somewhere';
    logger.error('Request failed', error, { requestId: 'abc123' });

    const [line, stack] = vi.mocked(console.error).mock.calls.map((call) => call[0] as string);
    expect(line).toContain('Request failed');
    expect(line).toContain('"error.message":"boom"');
    expect(line).not.toContain('at somewhere');
    expect(stack).toBe('Error: boom\n    at somewhere');
  });

  it('honours consoleOutput: false', () => {
    const { logger } = createLoggerService({
      config: { serviceName: 'api', environment: 'production', consoleOutput: false },
    });

    logger.info('quiet');
    logger.error('also quiet');

    expect(console.info).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('filters below the configured level', () => {
    const { logger } = createLoggerService({
      config: { serviceName: 'api', environment: 'production', logLevel: 'warn' },
    });

    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('carries child context into every record', () => {
    const { logger } = createLoggerService({
      config: { serviceName: 'api', environment: 'production' },
    });

    logger.child({ requestId: 'abc123' }).child({ userId: 'u1' }).info('Processing');

    const record = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(record.attributes).toEqual({ requestId: 'abc123', userId: 'u1' });
  });

  it('exports to the OTLP collector when otlp is configured', async () => {
    const fetchImpl = stubFetch();
    const service = createLoggerService({
      config: {
        serviceName: 'api',
        environment: 'production',
        otlp: { endpoint: ENDPOINT, fetchImpl },
      },
    });

    service.logger.child({ requestId: 'abc123' }).info('Processing', { port: 3000 });
    await service.shutdown();

    expect(exportedRecords(fetchImpl)).toEqual([
      {
        timeUnixNano: expect.any(String),
        severityNumber: 9,
        severityText: 'INFO',
        body: { stringValue: 'Processing' },
        attributes: [
          { key: 'requestId', value: { stringValue: 'abc123' } },
          { key: 'port', value: { intValue: '3000' } },
        ],
      },
    ]);
  });

  it('exports in development too, with resource attributes intact', async () => {
    const fetchImpl = stubFetch();
    const service = createLoggerService({
      config: {
        serviceName: 'api',
        serviceVersion: '1.0.0',
        environment: 'development',
        otlp: { endpoint: ENDPOINT, fetchImpl },
      },
    });

    service.logger.info('Processing');
    await service.shutdown();

    const payload = JSON.parse(
      String(
        ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
          .body
      )
    );
    expect(payload.resourceLogs[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'api' } },
      { key: 'service.version', value: { stringValue: '1.0.0' } },
      { key: 'deployment.environment', value: { stringValue: 'development' } },
    ]);
  });

  it('exports records that the console never sees (consoleOutput: false)', async () => {
    const fetchImpl = stubFetch();
    const service = createLoggerService({
      config: {
        serviceName: 'api',
        environment: 'production',
        consoleOutput: false,
        otlp: { endpoint: ENDPOINT, fetchImpl },
      },
    });

    service.logger.info('exported only');
    await service.shutdown();

    expect(console.info).not.toHaveBeenCalled();
    expect(exportedRecords(fetchImpl)).toHaveLength(1);
  });

  it('does not export records filtered out by the log level', async () => {
    const fetchImpl = stubFetch();
    const service = createLoggerService({
      config: {
        serviceName: 'api',
        environment: 'production',
        logLevel: 'warn',
        otlp: { endpoint: ENDPOINT, fetchImpl },
      },
    });

    service.logger.info('dropped');
    await service.shutdown();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('shutdown resolves without otlp configured', async () => {
    const service = createLoggerService({
      config: { serviceName: 'api', environment: 'production' },
    });

    await expect(service.shutdown()).resolves.toBeUndefined();
  });

  it('keeps logging usable when the collector is down', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const onError = vi.fn();
    const service = createLoggerService({
      config: {
        serviceName: 'api',
        environment: 'production',
        otlp: { endpoint: ENDPOINT, onError, fetchImpl },
      },
    });

    expect(() => service.logger.info('still fine')).not.toThrow();
    await service.shutdown();

    expect(console.info).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
