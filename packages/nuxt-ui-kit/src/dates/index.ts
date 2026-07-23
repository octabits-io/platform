import { computed, type Ref } from 'vue';
import { addDays, differenceInDays, eachDayOfInterval, format, parseISO } from 'date-fns';

/** ISO (`YYYY-MM-DD`) date range. Whether `end` is inclusive is the caller's convention. */
export interface Period {
  start: string;
  end: string;
}

/**
 * Number of days in a period, **inclusive** of both endpoints.
 * Example: `{ start: "2025-01-01", end: "2025-01-03" }` → 3 days.
 */
export function calculateDays(period: Period): number {
  return differenceInDays(new Date(period.end), new Date(period.start)) + 1;
}

/**
 * Number of nights in a period whose `end` is **exclusive** (departure
 * semantics). Example: `{ start: "2025-01-01", end: "2025-01-03" }` → 2 nights.
 */
export function calculateNights(period: Period): number {
  return differenceInDays(new Date(period.end), new Date(period.start));
}

/** Shift an ISO date string by n days; `''` stays `''`. */
export function shiftIso(iso: string, days: number): string {
  if (!iso || days === 0) return iso;
  try {
    return format(addDays(parseISO(iso), days), 'yyyy-MM-dd');
  } catch {
    return iso;
  }
}

/**
 * Converts between ISO date strings (start/end) and Date arrays.
 * Useful for bridging separate start/end date inputs with range picker components.
 */
export function useDateRangeInput(
  startRef: Ref<string | undefined>,
  endRef: Ref<string | undefined>,
) {
  const dateRange = computed<Date[]>({
    get() {
      if (!startRef.value || !endRef.value) return [];
      try {
        return eachDayOfInterval({
          start: parseISO(startRef.value),
          end: parseISO(endRef.value),
        });
      } catch {
        return [];
      }
    },
    set(dates: Date[]) {
      if (!dates || dates.length === 0) {
        startRef.value = undefined;
        endRef.value = undefined;
        return;
      }
      const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
      startRef.value = format(sorted[0]!, 'yyyy-MM-dd');
      endRef.value = format(sorted[sorted.length - 1]!, 'yyyy-MM-dd');
    },
  });

  const dayCount = computed(() => dateRange.value.length);

  return {
    dateRange,
    dayCount,
  };
}

export interface DateFormatterOptions {
  /** Read the active locale code (e.g. from vue-i18n's `locale.value`). */
  getLocale: () => string;
}

/**
 * Locale-aware date/time/currency formatting — the engine of an app-side
 * `useDateFormat()` composable (`createDateFormatter({ getLocale: () =>
 * locale.value })`). Inject the locale getter; no i18n dependency here.
 */
export function createDateFormatter(options: DateFormatterOptions) {
  const locale = () => options.getLocale();

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(locale());
  }

  function formatDateMedium(dateStr: string): string {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(locale(), {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  /** Customer-facing checkout date: the day after the (inclusive) last booked day. */
  function formatCheckoutDate(endDate: string, checkOutNextDay = true): string {
    const daysToAdd = checkOutNextDay ? 1 : 0;
    return addDays(new Date(endDate), daysToAdd).toLocaleDateString(locale());
  }

  function formatTimeFromString(timeStr: string): string {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const date = new Date();
    date.setHours(hours!, minutes!, 0, 0);
    return date.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  }

  function formatCurrency(amount: number, currencyCode: string): string {
    return new Intl.NumberFormat(locale(), {
      style: 'currency',
      currency: currencyCode,
    }).format(amount);
  }

  function formatDateTime(dateStr: string): string {
    return new Date(dateStr).toLocaleString(locale(), {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  return {
    formatDate,
    formatDateMedium,
    formatDateTime,
    formatCheckoutDate,
    formatTimeFromString,
    formatCurrency,
  };
}

export type DateFormatter = ReturnType<typeof createDateFormatter>;
