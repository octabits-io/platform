/**
 * OpenTelemetry Logging Types
 *
 * Provides type definitions for the structured logging system.
 */

/**
 * Log severity levels aligned with OpenTelemetry specification.
 * @see https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log attribute values - primitives and arrays of primitives.
 */
export type LogAttributeValue =
  | string
  | number
  | boolean
  | undefined
  | null
  | LogAttributeValue[]
  | { [key: string]: LogAttributeValue };

/**
 * Log attributes - key-value pairs for structured logging.
 */
export type LogAttributes = Record<string, LogAttributeValue>;

/**
 * Logger interface for structured logging.
 * All methods accept an optional attributes object for structured data.
 */
export interface Logger {
  /**
   * Log a debug message.
   * Use for detailed diagnostic information.
   */
  debug(message: string, attributes?: LogAttributes): void;

  /**
   * Log an info message.
   * Use for general operational information.
   */
  info(message: string, attributes?: LogAttributes): void;

  /**
   * Log a warning message.
   * Use for potentially harmful situations.
   */
  warn(message: string, attributes?: LogAttributes): void;

  /**
   * Log an error message.
   * Use for error events that might still allow the application to continue running.
   */
  error(message: string, error?: Error, attributes?: LogAttributes): void;

  /**
   * Create a child logger with additional context.
   * Context attributes are automatically included in all log messages.
   */
  child(context: LogAttributes): Logger;
}

/**
 * Configuration for the logging service.
 */
export interface LoggingConfig {
  /**
   * Service name for resource attribution.
   */
  serviceName: string;

  /**
   * Service version for resource attribution.
   */
  serviceVersion?: string;

  /**
   * Deployment environment (e.g., 'development', 'staging', 'production').
   */
  environment?: string;

  /**
   * Minimum log level to emit.
   * @default 'info'
   */
  logLevel?: LogLevel;

  /**
   * OTLP exporter configuration.
   * If provided, logs are batched and POSTed to an OTLP collector over
   * OTLP/HTTP, protobuf-encoded by default (no OpenTelemetry SDK involved).
   */
  otlp?: OtlpExporterConfig;

  /**
   * Whether to enable console output in addition to OTLP.
   * @default true
   */
  consoleOutput?: boolean;
}

/**
 * OTLP/HTTP log-export settings.
 *
 * `endpoint` and `headers` are the env-driven fields mirrored by
 * `config-schema`'s `LOGGING_CONFIG_SCHEMA`; the remaining knobs tune batching
 * and are expected to be set in code, if at all.
 */
export interface OtlpExporterConfig {
  /**
   * OTLP logs endpoint URL, including the signal path
   * (e.g., 'http://localhost:4318/v1/logs').
   */
  endpoint: string;

  /**
   * Optional headers for OTLP requests (auth tokens, tenant routing, …).
   */
  headers?: Record<string, string>;

  /**
   * Flush once this many records are buffered.
   * @default 512
   */
  maxBatchSize?: number;

  /**
   * Hard cap on buffered records. Once full, the OLDEST buffered records are
   * dropped to make room, so an unreachable collector can never grow the
   * process's memory without bound.
   * @default 2048
   */
  maxQueueSize?: number;

  /**
   * Delay before flushing a partial batch.
   * @default 5000
   */
  scheduledDelayMs?: number;

  /**
   * Per-request timeout for the export POST.
   * @default 10000
   */
  timeoutMs?: number;

  /**
   * Wire encoding for the export POST.
   *
   * `'protobuf'` is the OTLP spec's required encoding — every conformant
   * receiver accepts it. `'json'` is optional in the spec and some backends
   * refuse it outright, so switch only for a collector you know accepts it, or when
   * you want a readable payload while debugging.
   *
   * @default 'protobuf'
   */
  encoding?: 'protobuf' | 'json';

  /**
   * Called when an export fails or records are dropped.
   *
   * Defaults to a plain `console.error`. It must NEVER route back into a
   * `Logger` that feeds this exporter — a failing collector would then log its
   * own failures forever.
   */
  onError?: (error: Error) => void;

  /**
   * `fetch` implementation to use. Defaults to the global `fetch`.
   * Primarily a test seam.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Structured log record, shaped after the OpenTelemetry Logs Data Model.
 * This is what a `Logger` emits: the console renders it, and the OTLP
 * exporter encodes it.
 *
 * @see https://opentelemetry.io/docs/specs/otel/logs/data-model/
 */
export interface LogRecord {
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  severityNumber: number;
  severityText: string;
  /** The log message. */
  body: string;
  attributes: LogAttributes;
  resource: {
    'service.name': string;
    'service.version'?: string;
    'deployment.environment'?: string;
  };
}

/**
 * Severity number mapping for OpenTelemetry.
 * @see https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
 */
export const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 5,  // DEBUG
  info: 9,   // INFO
  warn: 13,  // WARN
  error: 17, // ERROR
};

/**
 * Check if a log level should be emitted based on the minimum level.
 */
export function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[minLevel];
}
