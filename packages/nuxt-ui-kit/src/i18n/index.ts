/**
 * Message fragments for the kit's fixed i18n key conventions: the `errors.*`
 * keys emitted by `createApiErrorMessenger` (matching the framework's error
 * response keys) and the `auth.*` session-lifecycle keys used by the OIDC
 * harness toasts. Deep-merge a fragment into the app's own messages per
 * locale; app-specific keys (e.g. sign-in branding) stay app-side.
 *
 * German ships in both registers: `de` addresses the reader informally (du),
 * `deFormal` formally (Sie). Pick whichever matches the app's voice — both
 * merge under the app's `de` locale.
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

export const kitMessagesDe: KitMessages = {
  errors: {
    internal_server_error: 'Ein unerwarteter Fehler ist aufgetreten',
    not_found: 'Ressource nicht gefunden',
    forbidden: 'Zugriff verweigert',
    validation_error: 'Validierungsfehler',
    unique_violation: 'Dieser Wert existiert bereits',
    foreign_key_violation: 'Der referenzierte Datensatz existiert nicht',
    exclusion_violation: 'Dieser Eintrag überschneidet sich mit einem bestehenden',
    service_unavailable:
      'Dienst vorübergehend nicht verfügbar. Bitte versuche es später erneut.',
  },
  auth: {
    sessionRenewFailedTitle: 'Sitzung konnte nicht erneuert werden',
    sessionRenewFailedDescription:
      'Wir konnten deine Sitzung nicht erneuern. Eventuell musst du dich neu anmelden.',
    sessionExpiredTitle: 'Sitzung abgelaufen',
    sessionExpiredDescription:
      'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.',
    signingIn: 'Anmeldung wird abgeschlossen...',
  },
  localeField: {
    translate: 'Fehlende Sprachen mit KI übersetzen',
    translateDone:
      'Keine Übersetzungen eingefügt | {count} Übersetzung eingefügt | {count} Übersetzungen eingefügt',
    inheritsBaseLocale: 'Übernimmt die Basissprache',
    translationStatus: {
      complete: 'Alle Übersetzungen vollständig',
      missing: 'Fehlende Übersetzungen — {details}',
    },
  },
  pageChrome: {
    back: 'Zurück',
    moreActions: 'Weitere Aktionen',
    help: 'Hilfe',
  },
};

export const kitMessagesDeFormal: KitMessages = {
  errors: {
    ...kitMessagesDe.errors,
    service_unavailable:
      'Dienst vorübergehend nicht verfügbar. Bitte versuchen Sie es später erneut.',
  },
  auth: {
    ...kitMessagesDe.auth,
    sessionRenewFailedDescription:
      'Wir konnten Ihre Sitzung nicht erneuern. Eventuell müssen Sie sich neu anmelden.',
    sessionExpiredDescription:
      'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.',
  },
  // Copy below never addresses the reader — same in both registers.
  localeField: kitMessagesDe.localeField,
  pageChrome: kitMessagesDe.pageChrome,
};
