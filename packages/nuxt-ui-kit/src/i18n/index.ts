/**
 * Message fragments for the kit's fixed i18n key conventions: the `errors.*`
 * keys emitted by `createApiErrorMessenger` (matching the framework's error
 * response keys) and the `auth.*` session-lifecycle keys used by the OIDC
 * harness toasts. Deep-merge a fragment into the app's own messages per
 * locale; app-specific keys (e.g. sign-in branding) stay app-side.
 *
 * Only English ships with the kit — it doubles as the reference for the full
 * key set. Apps provide their other locales themselves as `KitMessages`
 * objects, which keeps every translation (and its register/voice) app-side.
 */

export interface KitMessages {
  errors: {
    internal_server_error: string;
    not_found: string;
    forbidden: string;
    validation_error: string;
    unique_violation: string;
    foreign_key_violation: string;
    exclusion_violation: string;
    service_unavailable: string;
  };
  auth: {
    sessionRenewFailedTitle: string;
    sessionRenewFailedDescription: string;
    sessionExpiredTitle: string;
    sessionExpiredDescription: string;
    signingIn: string;
  };
  localeField: {
    translate: string;
    translateDone: string;
    inheritsBaseLocale: string;
    translationStatus: {
      complete: string;
      missing: string;
    };
  };
  pageChrome: {
    back: string;
    moreActions: string;
    help: string;
  };
}

export const kitMessagesEn: KitMessages = {
  errors: {
    internal_server_error: 'An unexpected error occurred',
    not_found: 'Resource not found',
    forbidden: 'Permission denied',
    validation_error: 'Validation error',
    unique_violation: 'This value already exists',
    foreign_key_violation: 'Referenced record does not exist',
    exclusion_violation: 'This entry overlaps with an existing one',
    service_unavailable: 'Service temporarily unavailable. Please try again later.',
  },
  auth: {
    sessionRenewFailedTitle: 'Session refresh failed',
    sessionRenewFailedDescription:
      "We couldn't refresh your session. You may need to sign in again.",
    sessionExpiredTitle: 'Session expired',
    sessionExpiredDescription: 'Your session has expired. Please sign in again.',
    signingIn: 'Completing sign in...',
  },
  localeField: {
    translate: 'Translate empty languages with AI',
    translateDone:
      'No translations added | {count} translation added | {count} translations added',
    inheritsBaseLocale: 'Inherits the base locale',
    translationStatus: {
      complete: 'All translations complete',
      missing: 'Missing translations — {details}',
    },
  },
  pageChrome: {
    back: 'Back',
    moreActions: 'More actions',
    help: 'Help',
  },
};

