import { describe, expect, it } from 'vitest';
import { createApiErrorMessenger } from './apiErrorMessenger.ts';

const MESSAGES: Record<string, string> = {
  'errors.not_found': 'Not found',
  'errors.internal_server_error': 'Something went wrong',
  'errors.validation_error': 'Validation failed',
  'validation.fields.email': 'Email address',
  'validation.messages.invalid_email': 'is not valid',
};

const messenger = () =>
  createApiErrorMessenger({
    t: (key) => MESSAGES[key] ?? key,
    te: (key) => key in MESSAGES,
    log: () => {},
  });

describe('createApiErrorMessenger', () => {
  it('translates a known error key via errors.*', () => {
    expect(messenger().getErrorMessage({ key: 'not_found', message: 'raw' })).toBe('Not found');
  });

  it('falls back to the raw server message for unknown keys', () => {
    expect(
      messenger().getErrorMessage({ key: 'exotic_error', message: 'Exotic broke' }),
    ).toBe('Exotic broke');
  });

  it('maps non-API errors to internal_server_error', () => {
    expect(messenger().getErrorMessage(new Error('boom'))).toBe('Something went wrong');
    expect(messenger().getErrorMessage('string error')).toBe('Something went wrong');
    expect(messenger().getErrorMessage(null)).toBe('Something went wrong');
  });

  it('unwraps Eden Treaty { value } envelopes', () => {
    expect(
      messenger().getErrorMessage({ status: 404, value: { key: 'not_found', message: 'raw' } }),
    ).toBe('Not found');
  });

  it('renders validation errors per field with translated names and messages', () => {
    const msg = messenger().getErrorMessage({
      key: 'validation_error',
      message: 'raw',
      fields: [
        { path: 'email', message: 'Invalid email' },
        { path: 'unknown_field', message: 'Untranslated message' },
      ],
    });
    expect(msg).toBe('Email address: is not valid, unknown_field: Untranslated message');
  });

  it('slugs punctuated messages and dotted paths into definable i18n keys', () => {
    const messages: Record<string, string> = {
      'validation.fields.items_0_email': 'First email',
      'validation.messages.expected_string_to_match_email': 'must be a valid email address',
    };
    const { getErrorMessage } = createApiErrorMessenger({
      t: (key) => messages[key] ?? key,
      te: (key) => key in messages,
      log: () => {},
    });
    const msg = getErrorMessage({
      key: 'validation_error',
      message: 'raw',
      fields: [
        // Raw path has dots (vue-i18n nesting), raw message has quotes —
        // neither is definable as a literal key without the slug.
        { path: 'items.0.email', message: "Expected string to match 'email'" },
      ],
    });
    expect(msg).toBe('First email: must be a valid email address');
  });

  it('falls back to errors.validation_error for an empty fields array', () => {
    expect(
      messenger().getErrorMessage({ key: 'validation_error', message: 'raw', fields: [] }),
    ).toBe('Validation failed');
  });

  it('exposes isValidationError as a type guard', () => {
    const m = messenger();
    expect(m.isValidationError({ key: 'validation_error', message: '', fields: [] })).toBe(true);
    expect(m.isValidationError({ key: 'not_found', message: '' })).toBe(false);
    expect(m.isValidationError(null)).toBe(false);
  });
});
