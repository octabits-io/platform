/**
 * OpenTelemetry-compatible Logger Service
 *
 * Provides structured logging with OpenTelemetry-compatible output format.
 * Logs are output as structured JSON that can be collected by log shippers
 * (e.g., Fluent Bit, Vector) and sent to OTLP collectors.
 */

import type { Logger, LogAttributes, LoggingConfig, LogLevel } from './types.ts';
import { LOG_LEVEL_SEVERITY, shouldLog } from './types.ts';

/**
 * Dependencies for creating the logger service.
 */
export interface LoggerServiceDeps {
  config: LoggingConfig;
}

/**
 * Structured log record format compatible with OpenTelemetry Logs Data Model.
 * @see https://opentelemetry.io/docs/specs/otel/logs/data-model/
 */
interface LogRecord {
  timestamp: string;
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: LogAttributes;
  resource: {
    'service.name': string;
    'service.version'?: string;
    'deployment.environment'?: string;
  };
}

/**
 * Structured logger that outputs OpenTelemetry-compatible JSON logs.
 */
class StructuredLogger implements Logger {
  private readonly serviceName: string;
  private readonly serviceVersion: string | undefined;
  private readonly environment: string | undefined;
  private readonly minLevel: LogLevel;
  private readonly context: LogAttributes;
  private readonly useConsole: boolean;

  constructor(
    serviceName: string,
    serviceVersion: string | undefined,
    environment: string | undefined,
    minLevel: LogLevel,
    useConsole: boolean,
    context: LogAttributes = {}
  ) {
    this.serviceName = serviceName;
    this.serviceVersion = serviceVersion;
    this.environment = environment;
    this.minLevel = minLevel;
    this.useConsole = useConsole;
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
    return new StructuredLogger(
      this.serviceName,
      this.serviceVersion,
      this.environment,
      this.minLevel,
      this.useConsole,
      { ...this.context, ...context }
    );
  }

  private emit(level: LogLevel, message: string, attributes?: LogAttributes): void {
    if (!shouldLog(level, this.minLevel)) {
      return;
    }

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
        'service.name': this.serviceName,
        ...(this.serviceVersion && { 'service.version': this.serviceVersion }),
        ...(this.environment && { 'deployment.environment': this.environment }),
      },
    };

    this.output(level, record);
  }

  private output(level: LogLevel, record: LogRecord): void {
    if (!this.useConsole) {
      return;
    }

    // Use appropriate console method for each level
    const logFn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug
      : console.info;

    // Output as JSON for structured logging
    logFn(JSON.stringify(record));
  }
}

/**
 * Human-readable console logger for development.
 */
class DevelopmentLogger implements Logger {
  private readonly serviceName: string;
  private readonly minLevel: LogLevel;
  private readonly context: LogAttributes;

  constructor(serviceName: string, minLevel: LogLevel, context: LogAttributes = {}) {
    this.serviceName = serviceName;
    this.minLevel = minLevel;
    this.context = context;
  }

  debug(message: string, attributes?: LogAttributes): void {
    if (!shouldLog('debug', this.minLevel)) return;
    console.debug(this.format('debug', message, attributes));
  }

  info(message: string, attributes?: LogAttributes): void {
    if (!shouldLog('info', this.minLevel)) return;
    console.info(this.format('info', message, attributes));
  }

  warn(message: string, attributes?: LogAttributes): void {
    if (!shouldLog('warn', this.minLevel)) return;
    console.warn(this.format('warn', message, attributes));
  }

  error(message: string, error?: Error, attributes?: LogAttributes): void {
    if (!shouldLog('error', this.minLevel)) return;
    const errorAttributes: LogAttributes = error
      ? {
          'error.type': error.name,
          'error.message': error.message,
          ...attributes,
        }
      : attributes ?? {};

    console.error(this.format('error', message, errorAttributes));
    if (error?.stack) {
      console.error(error.stack);
    }
  }

  child(context: LogAttributes): Logger {
    return new DevelopmentLogger(this.serviceName, this.minLevel, {
      ...this.context,
      ...context,
    });
  }

  private format(level: LogLevel, message: string, attributes?: LogAttributes): string {
    const timestamp = new Date().toISOString();
    const allAttributes = { ...this.context, ...attributes };
    const hasAttributes = Object.keys(allAttributes).length > 0;

    const prefix = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${this.serviceName}]`;

    if (hasAttributes) {
      return `${prefix} ${message} ${JSON.stringify(allAttributes)}`;
    }
    return `${prefix} ${message}`;
  }
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
 *   },
 * });
 *
 * const logger = loggerService.logger;
 * logger.info('Server started', { port: 3000 });
 *
 * const requestLogger = logger.child({ requestId: 'abc123' });
 * requestLogger.info('Processing request');
 * ```
 */
export function createLoggerService(deps: LoggerServiceDeps): LoggerService {
  const { config } = deps;
  const minLevel = config.logLevel ?? 'info';
  const environment = config.environment ?? 'development';
  const useConsole = config.consoleOutput ?? true;

  // Use development logger for development environment (human-readable)
  // Use structured logger for production (JSON format for log shippers)
  const isDevelopment = environment === 'development';

  let logger: Logger;

  if (isDevelopment) {
    logger = new DevelopmentLogger(config.serviceName, minLevel);
  } else {
    logger = new StructuredLogger(
      config.serviceName,
      config.serviceVersion,
      environment,
      minLevel,
      useConsole
    );
  }

  return {
    logger,
    child: (context) => logger.child(context),
    shutdown: async () => {
      // No-op for now, but provides lifecycle hook for future OTLP integration
    },
  };
}

export type { Logger, LogAttributes, LoggingConfig, LogLevel };
