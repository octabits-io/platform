/**
 * OpenTelemetry-compatible Logger Service
 *
 * Provides structured logging with OpenTelemetry-compatible output format.
 * Logs are output as structured JSON that can be collected by log shippers
 * (e.g., Fluent Bit, Vector) and sent to OTLP collectors — and, when `otlp` is
 * configured, exported straight to a collector over OTLP/HTTP as well.
 */

import type {
  Logger,
  LogAttributes,
  LoggingConfig,
  LogLevel,
  LogRecord,
} from './types.ts';
import { LOG_LEVEL_SEVERITY, shouldLog } from './types.ts';
import { createOtlpLogExporter, type OtlpLogExporter } from './otlp-exporter.ts';

/**
 * Dependencies for creating the logger service.
 */
export interface LoggerServiceDeps {
  config: LoggingConfig;
}

/** Console rendering style for a logger's own output. */
type OutputFormat = 'json' | 'pretty';

/** Everything a logger and its children share, resolved once at creation. */
interface LoggerOptions {
  serviceName: string;
  serviceVersion: string | undefined;
  environment: string | undefined;
  minLevel: LogLevel;
  format: OutputFormat;
  useConsole: boolean;
  /** Extra destination for every emitted record (the OTLP exporter). */
  sink: ((record: LogRecord) => void) | undefined;
}

/**
 * Structured logger.
 *
 * Building the {@link LogRecord} is shared by both output formats, so what a
 * collector receives is identical in development and production — only the
 * console rendering differs.
 */
class StructuredLogger implements Logger {
  private readonly options: LoggerOptions;
  private readonly context: LogAttributes;

  constructor(options: LoggerOptions, context: LogAttributes = {}) {
    this.options = options;
    this.context = context;
  }

  debug(message: string, attributes?: LogAttributes): void {
    this.emit('debug', message, attributes);
  }

  info(message: string, attributes?: LogAttributes): void {
    this.emit('info', message, attributes);
  }

  warn(message: string, attributes?: LogAttributes): void {
    this.emit('warn', message, attributes);
  }

  error(message: string, error?: Error, attributes?: LogAttributes): void {
    const errorAttributes: LogAttributes = error
      ? {
          'error.type': error.name,
          'error.message': error.message,
          'error.stack': error.stack,
          ...attributes,
        }
      : attributes ?? {};

    this.emit('error', message, errorAttributes);
  }

  child(context: LogAttributes): Logger {
    return new StructuredLogger(this.options, { ...this.context, ...context });
  }

  private emit(level: LogLevel, message: string, attributes?: LogAttributes): void {
    if (!shouldLog(level, this.options.minLevel)) {
      return;
    }

    const { serviceName, serviceVersion, environment } = this.options;

    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      severityNumber: LOG_LEVEL_SEVERITY[level],
      severityText: level.toUpperCase(),
      body: message,
      attributes: {
        ...this.context,
        ...attributes,
      },
      resource: {
        'service.name': serviceName,
        ...(serviceVersion && { 'service.version': serviceVersion }),
        ...(environment && { 'deployment.environment': environment }),
      },
    };

    // Export first: a console that throws (a closed stdout on a dying process)
    // must not cost us the record.
    this.options.sink?.(record);
    this.output(level, record);
  }

  private output(level: LogLevel, record: LogRecord): void {
    if (!this.options.useConsole) {
      return;
    }

    // Use appropriate console method for each level
    const logFn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug
      : console.info;

    if (this.options.format === 'json') {
      // Output as JSON for structured logging
      logFn(JSON.stringify(record));
      return;
    }

    logFn(formatPretty(record));

    // Stacks are unreadable inline — print them raw, below the message.
    const stack = record.attributes['error.stack'];
    if (typeof stack === 'string') {
      console.error(stack);
    }
  }
}

/**
 * Human-readable single-line rendering for development:
 * `[timestamp] [LEVEL] [service] message {attributes}`.
 *
 * `error.stack` is left out — it is printed separately, unescaped.
 */
function formatPretty(record: LogRecord): string {
  const { 'error.stack': _stack, ...attributes } = record.attributes;
  const hasAttributes = Object.keys(attributes).length > 0;

  const prefix =
    `[${record.timestamp}] [${record.severityText.padEnd(5)}] ` +
    `[${record.resource['service.name']}]`;

  if (hasAttributes) {
    return `${prefix} ${record.body} ${JSON.stringify(attributes)}`;
  }
  return `${prefix} ${record.body}`;
}

/**
 * Logger service that manages logger lifecycle.
 */
export interface LoggerService {
  /**
   * Get the root logger instance.
   */
  readonly logger: Logger;

  /**
   * Create a child logger with additional context.
   * Shorthand for `service.logger.child(context)`.
   */
  child(context: LogAttributes): Logger;

  /**
   * Shutdown the logger and flush pending logs.
   * Call this on application shutdown.
   *
   * With `otlp` configured this drains the export buffer and awaits the
   * in-flight requests — without it, whatever was still buffered is lost.
   */
  shutdown(): Promise<void>;
}

/**
 * Create a logger service.
 *
 * @param deps - Dependencies including logging configuration
 * @returns LoggerService instance
 *
 * @example
 * ```typescript
 * const loggerService = createLoggerService({
 *   config: {
 *     serviceName: 'my-api',
 *     serviceVersion: '1.0.0',
 *     environment: 'production',
 *     logLevel: 'info',
 *     // Optional: also export to a collector over OTLP/HTTP
 *     otlp: { endpoint: 'http://localhost:4318/v1/logs' },
 *   },
 * });
 *
 * const logger = loggerService.logger;
 * logger.info('Server started', { port: 3000 });
 *
 * const requestLogger = logger.child({ requestId: 'abc123' });
 * requestLogger.info('Processing request');
 *
 * // On shutdown — flushes buffered OTLP records
 * await loggerService.shutdown();
 * ```
 */
export function createLoggerService(deps: LoggerServiceDeps): LoggerService {
  const { config } = deps;
  const minLevel = config.logLevel ?? 'info';
  const environment = config.environment ?? 'development';
  const useConsole = config.consoleOutput ?? true;

  // Human-readable console in development; JSON in production for log shippers.
  // OTLP export, when configured, is identical in both.
  const isDevelopment = environment === 'development';

  let exporter: OtlpLogExporter | undefined;
  if (config.otlp) {
    exporter = createOtlpLogExporter(config.otlp);
  }

  const logger: Logger = new StructuredLogger({
    serviceName: config.serviceName,
    // Resource attributes are carried in every environment: the pretty
    // renderer ignores them, but an OTLP collector needs them in dev too.
    serviceVersion: config.serviceVersion,
    environment,
    minLevel,
    format: isDevelopment ? 'pretty' : 'json',
    useConsole,
    sink: exporter ? (record) => exporter.enqueue(record) : undefined,
  });

  return {
    logger,
    child: (context) => logger.child(context),
    shutdown: async () => {
      await exporter?.shutdown();
    },
  };
}

export type { Logger, LogAttributes, LoggingConfig, LogLevel, LogRecord };
