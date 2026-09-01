/**
 * Message fragments for the kit's fixed i18n key conventions — every namespace
 * the kit itself reads: the `errors.*` keys emitted by
 * `createApiErrorMessenger` (matching the framework's error response keys), the
 * `auth.*` session-lifecycle keys used by the OIDC harness toasts, and the
 * component contracts (`pageChrome.*`, `localeField.*`, `dateInput.*`,
 * `dateRange.*`, `flexPeriod.*`, `period.*`, `ai.review.*`). Deep-merge a
 * fragment into the app's own messages per locale; app-specific keys (e.g.
 * sign-in branding) stay app-side.
 *
 * Only English ships with the kit — it doubles as the reference for the full
 * key set, which is why the type is exhaustive rather than partial: a consumer
 * writing another locale is told at compile time which keys the kit will ask
 * for, instead of finding out when a component renders a raw key path.
 *
 * ```ts
 * const messages = { en: { ...kitMessagesEn, ...appMessagesEn } };
 * ```
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
    ai: string;
  };
  dateInput: {
    clear: string;
  };
  dateRange: {
    checkIn: string;
    checkOut: string;
    /** `{date}`, `{time}` */
    atTime: string;
    nextDay: string;
    checking: string;
    availabilityOk: string;
    availabilityConflict: string;
    availabilityPartial: string;
    /** Stated (not an error) when the whole selected period lies before today. */
    pastPeriod: string;
    errors: {
      bothRequired: string;
      endAfterStart: string;
      /** `{n}` */
      minDays: string;
      /** `{n}` */
      maxDays: string;
      /** `{date}` */
      blockedDate: string;
      /** `{dates}` */
      blockedRange: string;
    };
  };
  flexPeriod: {
    earliestStart: string;
    latestEnd: string;
    nightsLabel: string;
    clear: string;
    /** `{nights}` — already a rendered `period.travel.nights` count */
    windowSpan: string;
    /** `{nights}` */
    flexibility: string;
    /** `{start}`, `{end}` */
    example: string;
    errors: {
      /** `{n}` */
      minNights: string;
      /** `{n}` */
      maxNights: string;
      /** `{nights}`, `{window}` */
      nightsExceedWindow: string;
    };
  };
  /** Pluralized period labels — `|`-separated vue-i18n plural forms. */
  period: {
    travel: { tooltip: string; nights: string };
    booking: { tooltip: string; days: string };
  };
  ai: {
    review: {
      title: string;
      description: string;
      currentValue: string;
      apply: string;
      dismiss: string;
    };
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
    ai: 'AI',
  },
  dateInput: {
    clear: 'Clear date',
  },
  dateRange: {
    checkIn: 'From',
    checkOut: 'To',
    atTime: '{date} at {time}',
    nextDay: '(next day)',
    checking: 'Checking availability…',
    availabilityOk: 'Available',
    availabilityConflict: 'Not available',
    availabilityPartial: 'Partially available',
    pastPeriod: 'This period is in the past.',
    errors: {
      bothRequired: 'Pick both a start and an end date.',
      endAfterStart: 'The end date must not be before the start date.',
      minDays: 'Pick at least {n} days.',
      maxDays: 'Pick at most {n} days.',
      blockedDate: '{date} is not selectable.',
      blockedRange: 'The range covers blocked dates: {dates}',
    },
  },
  flexPeriod: {
    earliestStart: 'Earliest arrival',
    latestEnd: 'Latest departure',
    nightsLabel: 'Nights',
    clear: 'Clear the travel wish',
    windowSpan: 'Window: {nights}',
    flexibility: 'Flexibility: {nights}',
    example: 'For example {start} → {end}',
    errors: {
      minNights: 'Stay at least {n} nights.',
      maxNights: 'Stay at most {n} nights.',
      nightsExceedWindow: '{nights} do not fit a window of {window}.',
    },
  },
  period: {
    travel: {
      tooltip: 'Check-in → check-out',
      nights: '{n} night | {n} nights',
    },
    booking: {
      tooltip: 'First → last day covered',
      days: '{n} day | {n} days',
    },
  },
  ai: {
    review: {
      title: 'AI suggestion',
      description: 'Review the generated result before applying it.',
      currentValue: 'Current',
      apply: 'Apply',
      dismiss: 'Dismiss',
    },
  },
};

