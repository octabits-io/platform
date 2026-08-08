/**
 * OTLP/HTTP log exporter — plain `fetch`, no OpenTelemetry SDK.
 *
 * Batches {@link LogRecord}s and POSTs them as OTLP/HTTP **JSON** to a
 * collector's logs endpoint (e.g. `http://localhost:4318/v1/logs`). Keeping
 * this dependency-free is deliberate: `./logger` is a base module that every
 * other module imports, so it must not drag an SDK (or its transitive
 * dependency tree) into consumers that only ever log to stdout.
 *
 * Delivery is best-effort, in the same spirit as a log shipper's buffer:
 * exports never block the caller, a full buffer drops its oldest records
 * rather than growing without bound, and failures are reported through
 * `onError` instead of thrown. Logging must not be able to fail a request.
 *
 * @see https://opentelemetry.io/docs/specs/otlp/#otlphttp
 * @see https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto
 */

import type { LogAttributes, LogAttributeValue, LogRecord, OtlpExporterConfig } from './types.ts';

const DEFAULT_MAX_BATCH_SIZE = 512;
const DEFAULT_MAX_QUEUE_SIZE = 2048;
const DEFAULT_SCHEDULED_DELAY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Instrumentation scope reported for every exported record. */
const SCOPE_NAME = '@octabits-io/framework/logger';

/** How much of a failing collector's response body to quote back in the error. */
const ERROR_BODY_CHARS = 200;

/**
 * A batching OTLP log exporter.
 *
 * Feed it with {@link OtlpLogExporter.enqueue}; flush explicitly with
 * {@link OtlpLogExporter.forceFlush}, or drain it for good with
 * {@link OtlpLogExporter.shutdown} (what `LoggerService.shutdown()` calls).
 */
export interface OtlpLogExporter {
  /**
   * Buffer a record for export. Never throws and never blocks — it may
   * schedule or kick off a flush in the background.
   */
  enqueue(record: LogRecord): void;

  /** Export everything buffered and await all in-flight requests. */
  forceFlush(): Promise<void>;

  /**
   * Flush, then stop accepting records. Subsequent `enqueue` calls are
   * silently dropped, so a logger that outlives shutdown stays harmless.
   */
  shutdown(): Promise<void>;
}

/**
 * Create an OTLP/HTTP log exporter.
 *
 * @example
 * ```typescript
 * const exporter = createOtlpLogExporter({
 *   endpoint: 'http://localhost:4318/v1/logs',
 *   headers: { 'x-api-key': process.env.OTLP_TOKEN! },
 * });
 * ```
 */
export function createOtlpLogExporter(config: OtlpExporterConfig): OtlpLogExporter {
  const {
    endpoint,
    headers,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    scheduledDelayMs = DEFAULT_SCHEDULED_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onError = defaultOnError,
    fetchImpl,
  } = config;

  const queue: LogRecord[] = [];
  const inFlight = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dropped = 0;
  let closed = false;

  const report = (error: Error): void => {
    // A broken `onError` must not take down the caller that just logged.
    try {
      onError(error);
    } catch {
      // Nothing left to do — reporting the reporter would recurse.
    }
  };

  const reportDrops = (): void => {
    if (dropped === 0) return;
    const count = dropped;
    dropped = 0;
    report(
      new Error(
        `OTLP log exporter dropped ${count} record(s): buffer full (maxQueueSize=${maxQueueSize}). ` +
          `The collector at ${endpoint} is likely unreachable or slower than the log rate.`
      )
    );
  };

  const clearTimer = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const send = async (batch: LogRecord[]): Promise<void> => {
    const doFetch = fetchImpl ?? globalThis.fetch;
    try {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(encodeLogsPayload(batch)),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        report(
          new Error(
            `OTLP log export failed: ${response.status} ${response.statusText} from ${endpoint}` +
              (body ? ` — ${body.slice(0, ERROR_BODY_CHARS)}` : '')
          )
        );
      }
    } catch (cause) {
      report(
        new Error(`OTLP log export to ${endpoint} failed: ${errorMessage(cause)}`, { cause })
      );
    }
  };

  /** Drain the buffer into `maxBatchSize`-sized requests, all in parallel. */
  const drain = (): void => {
    clearTimer();
    reportDrops();

    while (queue.length > 0) {
      const batch = queue.splice(0, maxBatchSize);
      const request = send(batch).finally(() => {
        inFlight.delete(request);
      });
      inFlight.add(request);
    }
  };

  const settleInFlight = async (): Promise<void> => {
    // Each awaited request can spawn none of its own, but `forceFlush` may be
    // racing an `enqueue`-triggered drain, so loop until the set is empty.
    while (inFlight.size > 0) {
      await Promise.all([...inFlight]);
    }
  };

  return {
    enqueue(record) {
      if (closed) return;

      queue.push(record);

      if (queue.length > maxQueueSize) {
        // Head-drop: keep the newest records, since those describe whatever is
        // going wrong right now.
        const overflow = queue.length - maxQueueSize;
        queue.splice(0, overflow);
        dropped += overflow;
      }

      if (queue.length >= maxBatchSize) {
        drain();
        return;
      }

      if (timer === undefined) {
        const scheduled = setTimeout(drain, scheduledDelayMs) as ReturnType<typeof setTimeout> & {
          unref?: () => void;
        };
        // Never hold the process open just to flush logs.
        scheduled.unref?.();
        timer = scheduled;
      }
    },

    async forceFlush() {
      drain();
      await settleInFlight();
    },

    async shutdown() {
      closed = true;
      drain();
      await settleInFlight();
      reportDrops();
    },
  };
}

// ----------------------------------------------------------------------------
// OTLP/HTTP JSON encoding
// ----------------------------------------------------------------------------

/** OTLP `AnyValue`, JSON encoding. */
type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } };

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/**
 * Encode records into an OTLP `ExportLogsServiceRequest`.
 *
 * Records are grouped by resource so a process that logs under more than one
 * service identity still produces a spec-correct payload.
 *
 * Exported for tests.
 */
export function encodeLogsPayload(records: LogRecord[]): {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{ scope: { name: string }; logRecords: unknown[] }>;
  }>;
} {
  const groups = new Map<string, { resource: LogRecord['resource']; records: LogRecord[] }>();

  for (const record of records) {
    const key = JSON.stringify(record.resource);
    const group = groups.get(key);
    if (group) {
      group.records.push(record);
    } else {
      groups.set(key, { resource: record.resource, records: [record] });
    }
  }

  return {
    resourceLogs: [...groups.values()].map((group) => ({
      resource: { attributes: toKeyValues(group.resource as LogAttributes) },
      scopeLogs: [
        {
          scope: { name: SCOPE_NAME },
          logRecords: group.records.map(encodeRecord),
        },
      ],
    })),
  };
}

function encodeRecord(record: LogRecord): Record<string, unknown> {
  return {
    timeUnixNano: toUnixNano(record.timestamp),
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: { stringValue: record.body },
    attributes: toKeyValues(record.attributes),
  };
}

/**
 * ISO-8601 → OTLP's nanosecond string. Millisecond precision is all a
 * `Date`-based timestamp carries; the trailing zeros are honest.
 */
function toUnixNano(timestamp: string): string {
  const ms = Date.parse(timestamp);
  return `${Number.isNaN(ms) ? Date.now() : ms}000000`;
}

function toKeyValues(attributes: LogAttributes): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, raw] of Object.entries(attributes)) {
    const value = toAnyValue(raw);
    // `null`/`undefined` have no AnyValue representation — omit the key
    // entirely rather than inventing an empty string for it.
    if (value !== undefined) out.push({ key, value });
  }
  return out;
}

function toAnyValue(value: LogAttributeValue): OtlpAnyValue | undefined {
  if (value === null || value === undefined) return undefined;

  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'boolean':
      return { boolValue: value };
    case 'number':
      // NaN/Infinity are not representable in JSON — `JSON.stringify` would
      // silently turn them into `null` and break the payload's typing.
      if (!Number.isFinite(value)) return { stringValue: String(value) };
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }

  if (Array.isArray(value)) {
    const values: OtlpAnyValue[] = [];
    for (const item of value) {
      const encoded = toAnyValue(item);
      if (encoded !== undefined) values.push(encoded);
    }
    return { arrayValue: { values } };
  }

  return { kvlistValue: { values: toKeyValues(value) } };
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    // `AbortSignal.timeout` rejects with a TimeoutError whose message is terse.
    return cause.name === 'TimeoutError' ? `request timed out` : cause.message;
  }
  return String(cause);
}

function defaultOnError(error: Error): void {
  console.error(error.message);
}
