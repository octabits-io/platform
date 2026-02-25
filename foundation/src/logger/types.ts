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
   * If provided, logs will be sent to an OTLP collector.
   */
  otlp?: {
    /**
     * OTLP endpoint URL (e.g., 'http://localhost:4318/v1/logs').
     */
    endpoint: string;

    /**
     * Optional headers for OTLP requests.
     */
    headers?: Record<string, string>;
  };

  /**
   * Whether to enable console output in addition to OTLP.
   * @default true in development, false in production
   */
  consoleOutput?: boolean;
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
