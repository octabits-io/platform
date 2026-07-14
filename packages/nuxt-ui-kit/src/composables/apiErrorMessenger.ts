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
 * - `validation.fields.<slug>` — display names for validated fields
 * - `validation.messages.<slug>` — validation message texts
 *
 * `<slug>` is the path/message lowercased with every non-alphanumeric run
 * collapsed to a single `_` (e.g. path `items.0.name` → `items_0_name`,
 * message `Expected string to match 'email'` →
 * `expected_string_to_match_email`) — so every derivable key is a flat,
 * definable vue-i18n key. Raw paths/messages with dots or punctuation are
 * not definable (dots nest in vue-i18n), which previously made this branch
 * unimplementable for most real messages.
 *
 * Framework-free: pass `t`/`te` from your i18n instance (the app-side
 * composable is typically `const { t, te } = useI18n()` + this factory).
 * Eden Treaty error envelopes (`{ value }`) are unwrapped automatically.
 */
/** Lowercase + collapse every non-alphanumeric run to `_` (trimmed) — a flat, definable vue-i18n key segment. */
function i18nSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

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
        const fieldKey = `validation.fields.${i18nSlug(f.path)}`;
        const fieldName = te(fieldKey) ? t(fieldKey) : f.path;

        const messageKey = `validation.messages.${i18nSlug(f.message)}`;
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
