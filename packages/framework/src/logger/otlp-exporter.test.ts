import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOtlpLogExporter, encodeLogsPayload } from './otlp-exporter.ts';
import { decodeLogsProtobuf } from './otlp-protobuf.testing.ts';
import type { LogAttributes, LogRecord } from './types.ts';

const ENDPOINT = 'http://collector.test:4318/v1/logs';

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: '2026-08-08T10:00:00.000Z',
    severityNumber: 9,
    severityText: 'INFO',
    body: 'hello',
    attributes: {},
    resource: { 'service.name': 'api' },
    ...overrides,
  };
}

/** `fetch` stub that records calls and resolves 200 by default. */
function stubFetch(impl?: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.fn(async (url: unknown, init: unknown) => {
    if (impl) return impl(String(url), init as RequestInit);
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

/**
 * Bodies of every export POST made to a stub, decoded off the wire — protobuf
 * by default, so these assertions cover the encoding real deployments send.
 */
function sentPayloads(fetchImpl: typeof fetch): Array<ReturnType<typeof encodeLogsPayload>> {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => {
    const body = (call[1] as RequestInit).body;
    return body instanceof Uint8Array
      ? decodeLogsProtobuf(body)
      : JSON.parse(String(body));
  });
}

describe('encodeLogsPayload', () => {
  it('encodes a record into the OTLP logs envelope', () => {
    const payload = encodeLogsPayload([
      record({
        body: 'Server started',
        attributes: { port: 3000 },
        resource: {
          'service.name': 'api',
          'service.version': '1.2.3',
          'deployment.environment': 'production',
        },
      }),
    ]);

    expect(payload).toEqual({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'api' } },
              { key: 'service.version', value: { stringValue: '1.2.3' } },
              { key: 'deployment.environment', value: { stringValue: 'production' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: '@octabits-io/framework/logger' },
              logRecords: [
                {
                  timeUnixNano: `${Date.parse('2026-08-08T10:00:00.000Z')}000000`,
                  severityNumber: 9,
                  severityText: 'INFO',
                  body: { stringValue: 'Server started' },
                  attributes: [{ key: 'port', value: { intValue: '3000' } }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('maps each attribute type to its AnyValue representation', () => {
    const attributes: LogAttributes = {
      str: 'a',
      int: 42,
      double: 1.5,
      bool: true,
      list: ['a', 1],
      nested: { inner: 'v' },
    };

    const encoded = encodeLogsPayload([record({ attributes })])
      .resourceLogs[0]!.scopeLogs[0]!.logRecords[0] as { attributes: unknown[] };

    expect(encoded.attributes).toEqual([
      { key: 'str', value: { stringValue: 'a' } },
      { key: 'int', value: { intValue: '42' } },
      { key: 'double', value: { doubleValue: 1.5 } },
      { key: 'bool', value: { boolValue: true } },
      {
        key: 'list',
        value: { arrayValue: { values: [{ stringValue: 'a' }, { intValue: '1' }] } },
      },
      {
        key: 'nested',
        value: { kvlistValue: { values: [{ key: 'inner', value: { stringValue: 'v' } }] } },
      },
    ]);
  });

  it('omits null/undefined attributes and keeps non-finite numbers JSON-safe', () => {
    const encoded = encodeLogsPayload([
      record({ attributes: { gone: null, missing: undefined, nan: NaN, inf: Infinity } }),
    ]).resourceLogs[0]!.scopeLogs[0]!.logRecords[0] as { attributes: unknown[] };

    expect(encoded.attributes).toEqual([
      { key: 'nan', value: { stringValue: 'NaN' } },
      { key: 'inf', value: { stringValue: 'Infinity' } },
    ]);
    // Round-trips as valid JSON — no `null` smuggled in where a value is typed.
    expect(JSON.parse(JSON.stringify(encoded)).attributes).toEqual(encoded.attributes);
  });

  it('sends integers beyond 2^53 as doubles rather than an unencodable int64', () => {
    // int64 only holds exact integers up to 2^63, and `String` gives up on
    // integer notation entirely at 1e21 ("1e+21") — a form the protobuf
    // encoder's BigInt parse rejects. A double is representable either way and
    // is no less precise than the JS number already was.
    const encoded = encodeLogsPayload([
      record({
        attributes: {
          safe: Number.MAX_SAFE_INTEGER,
          beyond: 2 ** 53,
          huge: 1e21,
        },
      }),
    ]).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;

    expect(encoded.attributes).toEqual([
      { key: 'safe', value: { intValue: '9007199254740991' } },
      { key: 'beyond', value: { doubleValue: 9007199254740992 } },
      { key: 'huge', value: { doubleValue: 1e21 } },
    ]);
  });

  it('groups records by resource', () => {
    const payload = encodeLogsPayload([
      record({ resource: { 'service.name': 'api' }, body: 'one' }),
      record({ resource: { 'service.name': 'worker' }, body: 'two' }),
      record({ resource: { 'service.name': 'api' }, body: 'three' }),
    ]);

    expect(payload.resourceLogs).toHaveLength(2);
    expect(payload.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(2);
    expect(payload.resourceLogs[1]!.scopeLogs[0]!.logRecords).toHaveLength(1);
  });
});

describe('createOtlpLogExporter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs protobuf to the endpoint with the configured headers', async () => {
    const fetchImpl = stubFetch();
    const exporter = createOtlpLogExporter({
      endpoint: ENDPOINT,
      headers: { 'x-api-key': 'secret' },
      fetchImpl,
    });

    exporter.enqueue(record());
    await exporter.forceFlush();

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/x-protobuf',
      'x-api-key': 'secret',
    });
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(sentPayloads(fetchImpl)[0]!.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(1);
  });

  it('POSTs JSON instead when the encoding is overridden', async () => {
    const fetchImpl = stubFetch();
    const exporter = createOtlpLogExporter({ endpoint: ENDPOINT, encoding: 'json', fetchImpl });

    exporter.enqueue(record({ body: 'hello' }));
    await exporter.forceFlush();

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(String(init.body))).toEqual(encodeLogsPayload([record({ body: 'hello' })]));
  });

  it('keeps content-type authoritative over a caller-supplied header', async () => {
    // The body is encoded here, so the caller cannot be allowed to relabel it
    // — a `content-type: application/json` left over from the JSON default
    // would otherwise announce JSON while shipping protobuf bytes.
    const fetchImpl = stubFetch();
    const exporter = createOtlpLogExporter({
      endpoint: ENDPOINT,
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
      fetchImpl,
    });

    exporter.enqueue(record());
    await exporter.forceFlush();

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({
      'content-type': 'application/x-protobuf',
      'x-api-key': 'secret',
    });
  });

  it('exports the rest of a batch when one attribute holds an unencodable number', async () => {
    // Encoding runs once per batch, so a value that breaks it takes every
    // record down with it, not just its own.
    const fetchImpl = stubFetch();
    const onError = vi.fn();
    const exporter = createOtlpLogExporter({ endpoint: ENDPOINT, onError, fetchImpl });

    for (let i = 0; i < 9; i++) exporter.enqueue(record({ body: `healthy ${i}` }));
    exporter.enqueue(record({ body: 'huge', attributes: { size: 1e21 } }));
    await exporter.forceFlush();

    expect(onError).not.toHaveBeenCalled();
    const logRecords = sentPayloads(fetchImpl)[0]!.resourceLogs[0]!.scopeLogs[0]!.logRecords;
    expect(logRecords).toHaveLength(10);
    expect(logRecords[9]!.attributes).toEqual([{ key: 'size', value: { doubleValue: 1e21 } }]);
  });

  it('does not export anything while the buffer is below the batch size', async () => {
    const fetchImpl = stubFetch();
    const exporter = createOtlpLogExporter({ endpoint: ENDPOINT, maxBatchSize: 3, fetchImpl });

    exporter.enqueue(record());
    exporter.enqueue(record());
    await Promise.resolve();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('flushes automatically once the batch size is reached', async () => {
    const fetchImpl = stubFetch();
    const exporter = createOtlpLogExporter({ endpoint: ENDPOINT, maxBatchSize: 2, fetchImpl });

    exporter.enqueue(record({ body: 'one' }));
    exporter.enqueue(record({ body: 'two' }));
    await exporter.forceFlush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sentPayloads(fetchImpl)[0]!.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(2);
  });

  it('splits an over-sized buffer into batch-sized requests', async () => {
    const fetchImpl = stubFetch();
    const exporter = createOtlpLogExporter({ endpoint: ENDPOINT, maxBatchSize: 2, fetchImpl });

    // Enqueued under a paused scheduler, then drained at once.
    vi.useFakeTimers();
    for (let i = 0; i < 5; i += 1) exporter.enqueue(record({ body: `r${i}` }));
    await exporter.forceFlush();

    const batches = sentPayloads(fetchImpl).map(
      (p) => p.resourceLogs[0]!.scopeLogs[0]!.logRecords.length
    );
    expect(batches.reduce((a, b) => a + b, 0)).toBe(5);
    expect(Math.max(...batches)).toBeLessThanOrEqual(2);
  });

  it('flushes a partial batch after the scheduled delay', async () => {
    vi.useFakeTimers();
    const fetchImpl = stubFetch();
    const exporter = createOtlpLogExporter({
      endpoint: ENDPOINT,
      maxBatchSize: 100,
      scheduledDelayMs: 5_000,
      fetchImpl,
    });

    exporter.enqueue(record());
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a non-2xx response through onError without throwing', async () => {
    const onError = vi.fn();
    const fetchImpl = stubFetch(async () => new Response('nope', { status: 503 }));
    const exporter = createOtlpLogExporter({ endpoint: ENDPOINT, onError, fetchImpl });

    exporter.enqueue(record());
    await expect(exporter.forceFlush()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    const message = (onError.mock.calls[0]![0] as Error).message;
    expect(message).toContain('503');
    expect(message).toContain('nope');
  });

  it('reports a transport failure through onError without throwing', async () => {
    const onError = vi.fn();
    const fetchImpl = stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const exporter = createOtlpLogExporter({ endpoint: ENDPOINT, onError, fetchImpl });

    exporter.enqueue(record());
    await expect(exporter.forceFlush()).resolves.toBeUndefined();

    expect((onError.mock.calls[0]![0] as Error).message).toContain('ECONNREFUSED');
  });

  it('enqueue never throws when the collector is unreachable', () => {
    const fetchImpl = stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const exporter = createOtlpLogExporter({
      endpoint: ENDPOINT,
      maxBatchSize: 1,
      onError: () => {},
      fetchImpl,
    });

    expect(() => exporter.enqueue(record())).not.toThrow();
  });

  it('drops the oldest records once the queue is full, and reports the loss', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const fetchImpl = stubFetch();
    const exporter = createOtlpLogExporter({
      endpoint: ENDPOINT,
      maxBatchSize: 100,
      maxQueueSize: 2,
      onError,
      fetchImpl,
    });

    exporter.enqueue(record({ body: 'oldest' }));
    exporter.enqueue(record({ body: 'middle' }));
    exporter.enqueue(record({ body: 'newest' }));
    await exporter.forceFlush();

    const bodies = sentPayloads(fetchImpl)[0]!.resourceLogs[0]!.scopeLogs[0]!.logRecords.map(
      (r) => (r as { body: { stringValue: string } }).body.stringValue
    );
    expect(bodies).toEqual(['middle', 'newest']);
    expect((onError.mock.calls[0]![0] as Error).message).toContain('dropped 1 record(s)');
  });

  it('survives an onError implementation that throws', async () => {
    const fetchImpl = stubFetch(async () => new Response(null, { status: 500 }));
    const exporter = createOtlpLogExporter({
      endpoint: ENDPOINT,
      onError: () => {
        throw new Error('reporter exploded');
      },
      fetchImpl,
    });

    exporter.enqueue(record());
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
  });

  it('flushes on shutdown and ignores records enqueued afterwards', async () => {
    const fetchImpl = stubFetch();
    const exporter = createOtlpLogExporter({ endpoint: ENDPOINT, maxBatchSize: 100, fetchImpl });

    exporter.enqueue(record());
    await exporter.shutdown();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    exporter.enqueue(record());
    await exporter.forceFlush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('awaits in-flight requests before shutdown resolves', async () => {
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;

    const fetchImpl = stubFetch(async () => {
      await inFlight;
      settled = true;
      return new Response(null, { status: 200 });
    });
    const exporter = createOtlpLogExporter({ endpoint: ENDPOINT, maxBatchSize: 1, fetchImpl });

    exporter.enqueue(record());
    const shutdown = exporter.shutdown();
    expect(settled).toBe(false);

    release();
    await shutdown;
    expect(settled).toBe(true);
  });
});
