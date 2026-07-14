// Internal retry helper — a self-contained copy of the generic `withRetry`
// utility (extraction catalog #42, published as @octabits-io/framework/utils).
//
// It is copied in-package rather than imported from foundation/utils so the
// storage package can keep its foundation floor at the widely-available
// `>=0.2.0` (npm foundation@0.2.0 does not ship the `./utils` subpath). Not
// part of the public API — do not export from any entry point.
import type { Logger } from '../../logger/index.ts';

// Retry configuration
export interface RetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffMultiplier: number;
}

export interface RetryOptions {
  config?: RetryConfig;
  logger?: Logger;
}

const defaultRetryConfig: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

export const withRetry = async <T>(
  operation: () => Promise<T>,
  operationName: string,
  isRetryableError?: (error: unknown) => boolean,
  context?: Record<string, string>,
  options: RetryOptions = {}
): Promise<T> => {
  const config = options.config ?? defaultRetryConfig;
  const logger = options.logger;
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry if it's not a retryable error or it's the last attempt
      const isRetryable = isRetryableError?.(error) ?? true;
      if (!isRetryable || attempt === config.maxAttempts) {
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(
        config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
        config.maxDelayMs
      );
      const jitteredDelay = delay + Math.random() * delay * 0.1; // Add 10% jitter

      if (logger) {
        logger.warn('Operation failed, retrying', { operationName, attempt, maxAttempts: config.maxAttempts, delayMs: Math.round(jitteredDelay), ...context });
      }

      await new Promise(resolve => setTimeout(resolve, jitteredDelay));
    }
  }

  throw lastError;
};
