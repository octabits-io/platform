/** `{ key, message }` API error body (an OctError over the wire). */
export interface ApiErrorLike {
  key: string;
  message: string;
}

/** `validation_error` body carrying per-field failures. */
export interface ValidationApiErrorLike extends ApiErrorLike {
  key: 'validation_error';
  fields: { path: string; message: string }[];
}

export interface ApiErrorMessengerOptions {
  /** Translate a key (assumed to exist). */
  t: (key: string) => string;
  /** Does a translation exist for this key? */
  te: (key: string) => boolean;
  /** Default `console.error`. Pass `() => {}` to silence. */
  log?: (message: string, error: unknown) => void;
}

/**
 * Map API error bodies to user-facing i18n strings using a fixed key
 * convention the consumer's locale files fulfil:
 *
 * - `errors.<key>` — one entry per API error key (fallback: the raw
 *   server `message`, and `errors.internal_server_error` for non-API errors)
 * - `validation.fields.<path>` — display names for validated fields
 * - `validation.messages.<snake_cased_message>` — validation message texts
 *
 * Framework-free: pass `t`/`te` from your i18n instance (the app-side
 * composable is typically `const { t, te } = useI18n()` + this factory).
 * Eden Treaty error envelopes (`{ value }`) are unwrapped automatically.
 */
export function createApiErrorMessenger(options: ApiErrorMessengerOptions) {
  const { t, te } = options;
  const log = options.log ?? ((message, error) => console.error(message, error));

  function isApiError(error: unknown): error is ApiErrorLike {
    return typeof error === 'object' && error !== null && 'key' in error && 'message' in error;
  }

  function isValidationError(error: unknown): error is ValidationApiErrorLike {
    return isApiError(error) && error.key === 'validation_error';
  }

  function getErrorMessage(error: unknown): string {
    log('API Error:', error);

    let actualError = error;
    if (typeof error === 'object' && error !== null && 'value' in error) {
      actualError = (error as { value: unknown }).value;
    }

    if (isValidationError(actualError)) {
      const fieldMessages = actualError.fields.map((f) => {
        const fieldKey = `validation.fields.${f.path}`;
        const fieldName = te(fieldKey) ? t(fieldKey) : f.path;

        const messageKey = `validation.messages.${f.message.toLowerCase().replace(/\s+/g, '_')}`;
        const message = te(messageKey) ? t(messageKey) : f.message;

        return `${fieldName}: ${message}`;
      });
      return fieldMessages.join(', ') || t('errors.validation_error');
    }

    if (!isApiError(actualError)) {
      return t('errors.internal_server_error');
    }

    const errorKey = `errors.${actualError.key}`;
    if (te(errorKey)) {
      return t(errorKey);
    }

    return actualError.message;
  }

  return {
    getErrorMessage,
    isValidationError,
  };
}
