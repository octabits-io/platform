import { ok, err, toOctError, type Result, type OctError } from '@octabits-io/foundation/result';
import ical from 'ical.js';

// ============================================================================
// Base API — raw event ranges
// ============================================================================

/**
 * A calendar-and-clock reading of an occurrence boundary **in the event's own
 * timezone** (its TZID), captured at parse time while ical.js still knows the
 * zone. These components are timezone-independent: they do not depend on the
 * server process's `TZ`. `month` is 1-based (1–12). For all-day (`VALUE=DATE`)
 * boundaries `hour`/`minute`/`second` are `0`.
 */
export interface ICalWallClock {
  year: number;
  /** 1-based month (1–12). */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * A single expanded VEVENT occurrence, in wall-clock JS `Date`s as parsed by
 * ical.js. This is the neutral, domain-free representation: no booking or
 * rental semantics, no day collapsing.
 */
export interface ICalEventRange {
  /** Occurrence start (inclusive), as an absolute instant. */
  start: Date;
  /** Occurrence end (**exclusive**, per iCal DTEND semantics), absolute instant. */
  end: Date;
  /**
   * Start boundary as wall-clock components in the event's own timezone.
   * Use these (not `start.getHours()`/local getters) for day/hour logic so
   * results don't shift with the server's `TZ`.
   */
  startWallClock: ICalWallClock;
  /** End boundary as wall-clock components in the event's own timezone. */
  endWallClock: ICalWallClock;
  /** VEVENT SUMMARY, or `''` when absent. */
  summary: string;
  /** VEVENT UID. */
  uid: string;
  /** `true` for whole-day events (`DTSTART;VALUE=DATE`). */
  allDay: boolean;
}

export interface ParseEventRangesOptions {
  /**
   * Upper bound for RRULE expansion. Recurrence iteration stops once an
   * occurrence starts at or after this instant. Strongly recommended for
   * recurring feeds — without it, expansion runs until `maxOccurrencesPerEvent`.
   */
  windowEnd?: Date;
  /**
   * Lower bound. Occurrences whose (exclusive) end is at or before this instant
   * are dropped. Omit to keep everything up to `windowEnd`.
   */
  windowStart?: Date;
  /**
   * Hard cap on the number of occurrences expanded per event. Guards against
   * pathological rules (e.g. `FREQ=SECONDLY`) spinning the CPU.
   * @default 5000
   */
  maxOccurrencesPerEvent?: number;
}

// Safety bound on RRULE expansion. A daily recurrence over a 12-month window
// yields ~365 occurrences; this gives 13× headroom for hourly events and caps
// abusive rules (e.g. FREQ=SECONDLY) before they spin the CPU.
const MAX_OCCURRENCES_PER_EVENT = 5000;

// ============================================================================
// Optional layer — day-blocking collapse
// ============================================================================

/**
 * A calendar day range that should be treated as blocked, as ISO `date`
 * strings (`YYYY-MM-DD`). Both ends are inclusive.
 */
export interface BlockedDateRange {
  start: string;
  end: string;
  summary: string;
}

export interface CollapseToBlockedDateRangesOptions {
  /**
   * Hour-of-day threshold for the timed-event heuristic. A timed event that
   * starts before this hour also blocks the previous day; one that ends before
   * this hour stops on the previous day. Matches check-in/check-out style
   * blocking.
   * @default 12
   */
  hourThreshold?: number;
  /**
   * Cap on occurrences expanded per event during collapse.
   * @default 5000
   */
  maxOccurrencesPerEvent?: number;
}

const MS_PER_DAY = 86_400_000;

/** Capture an ical.js `Time` as timezone-independent wall-clock components. */
function toWallClock(t: InstanceType<typeof ical.Time>): ICalWallClock {
  return {
    year: t.year,
    month: t.month,
    day: t.day,
    hour: t.hour,
    minute: t.minute,
    second: t.second,
  };
}

/**
 * Anchor wall-clock components into a UTC `Date` so day/hour arithmetic is
 * independent of the server's `TZ`: the UTC fields carry the event's own local
 * Y/M/D/H/M/S. Arithmetic then uses UTC getters exclusively (never local ones),
 * and UTC has no DST, so `±1 day` is always exactly 24h.
 */
function wallClockToUtcDate(w: ICalWallClock): Date {
  return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function addUtcSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

/** Whole-day index (days since epoch) of a UTC-anchored wall-clock `Date`. */
function utcDayIndex(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

/** Whole-day index of a window boundary, read by calendar day in UTC. */
function windowDayIndex(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY,
  );
}

/** End of a window boundary's calendar day, in UTC — bounds RRULE expansion. */
function utcEndOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999),
  );
}

/** Format a UTC-anchored wall-clock `Date` as `YYYY-MM-DD` from its UTC fields. */
function formatWallClockIso(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface ICalParserService {
  /**
   * Parse iCal data into raw event ranges, expanding RRULEs.
   *
   * This is the domain-free base API: it returns each VEVENT occurrence as-is
   * (start, exclusive end, summary, uid, all-day flag). Events missing
   * DTSTART, DTEND, or UID are skipped.
   */
  parseEventRanges(
    icalData: string,
    options?: ParseEventRangesOptions,
  ): Result<ICalEventRange[], OctError>;

  /**
   * Collapse iCal data into blocked **calendar-day** ranges within
   * `[windowStart, windowEnd]`.
   *
   * This is the optional, opinionated layer on top of {@link parseEventRanges}.
   * All-day events map to their date span (DTEND is exclusive, so the last day
   * is dropped). Timed events are collapsed to whole days using the
   * `hourThreshold` heuristic (see {@link CollapseToBlockedDateRangesOptions}).
   * Ranges that do not overlap the window are filtered out.
   */
  collapseToBlockedDateRanges(
    icalData: string,
    windowStart: Date,
    windowEnd: Date,
    options?: CollapseToBlockedDateRangesOptions,
  ): Result<BlockedDateRange[], OctError>;
}

// No construction-time dependencies — pure parsing logic.
export type CreateICalParserServiceParams = Record<string, never>;

export const createICalParserService = (_params: CreateICalParserServiceParams = {}): ICalParserService => {
  const parseEventRanges = (
    icalData: string,
    options: ParseEventRangesOptions = {},
  ): Result<ICalEventRange[], OctError> => {
    try {
      const maxOccurrences = options.maxOccurrencesPerEvent ?? MAX_OCCURRENCES_PER_EVENT;
      const windowStartMs = options.windowStart ? options.windowStart.getTime() : null;
      const rangeEnd = options.windowEnd ? ical.Time.fromJSDate(options.windowEnd) : null;

      const comp = new ical.Component(ical.parse(icalData));
      const ranges: ICalEventRange[] = [];

      comp.getAllSubcomponents('vevent').forEach((vevent) => {
        const iCalEvent = new ical.Event(vevent);

        const dtstart = iCalEvent.startDate;
        const dtend = iCalEvent.endDate;
        const uid = iCalEvent.uid;

        if (!dtstart || !dtend || !uid) {
          return;
        }

        const iterator = iCalEvent.iterator(dtstart);

        let occurrenceCount = 0;
        for (
          let next = iterator.next();
          next && (rangeEnd === null || next.compare(rangeEnd) < 0);
          next = iterator.next()
        ) {
          if (++occurrenceCount > maxOccurrences) break;

          const currentEvent = iCalEvent.getOccurrenceDetails(next);
          const eventStart = currentEvent.startDate.toJSDate();
          const eventEnd = currentEvent.endDate.toJSDate();

          // Drop occurrences that already ended before the window opened.
          if (windowStartMs !== null && eventEnd.getTime() <= windowStartMs) {
            continue;
          }

          ranges.push({
            start: eventStart,
            end: eventEnd,
            startWallClock: toWallClock(currentEvent.startDate),
            endWallClock: toWallClock(currentEvent.endDate),
            summary: iCalEvent.summary ?? '',
            uid,
            allDay: currentEvent.endDate.isDate,
          });
        }
      });

      return ok(ranges);
    } catch (e) {
      return err(toOctError(e));
    }
  };

  const collapseToBlockedDateRanges = (
    icalData: string,
    windowStart: Date,
    windowEnd: Date,
    options: CollapseToBlockedDateRangesOptions = {},
  ): Result<BlockedDateRange[], OctError> => {
    const hourThreshold = options.hourThreshold ?? 12;

    // Bound RRULE expansion by the end of the window's final day (UTC calendar
    // day, so the bound is independent of the server's TZ).
    const base = parseEventRanges(icalData, {
      windowEnd: utcEndOfDay(windowEnd),
      maxOccurrencesPerEvent: options.maxOccurrencesPerEvent,
    });
    if (!base.ok) {
      return base;
    }

    // All day/hour reasoning runs on the events' own wall-clock components,
    // anchored into UTC `Date`s — never on server-local getters — so the
    // collapsed output is identical regardless of the process's `TZ`.
    const collapsed: { start: Date; end: Date; summary: string }[] = [];

    for (const event of base.value) {
      let startDate = wallClockToUtcDate(event.startWallClock);
      const wallEnd = wallClockToUtcDate(event.endWallClock);
      // DTEND is non-inclusive: step back to the last blocked instant/day.
      let endDate = event.allDay ? addUtcDays(wallEnd, -1) : addUtcSeconds(wallEnd, -1);

      if (event.allDay) {
        // Guard against inverted ranges (edge cases in iCal data).
        if (utcDayIndex(startDate) > utcDayIndex(endDate)) {
          continue;
        }
        collapsed.push({ start: startDate, end: endDate, summary: event.summary });
      } else {
        if (event.startWallClock.hour < hourThreshold) {
          // Starts before the threshold → also block the previous day.
          startDate = addUtcDays(startDate, -1);
        }
        if (endDate.getUTCHours() < hourThreshold) {
          // Ends before the threshold → stop on the previous day.
          endDate = addUtcDays(endDate, -1);
        }

        // Validate on calendar days only (day-level blocking).
        if (utcDayIndex(startDate) > utcDayIndex(endDate)) {
          continue;
        }
        collapsed.push({ start: startDate, end: endDate, summary: event.summary });
      }
    }

    // Keep only ranges overlapping the requested window, compared at day level
    // with **inclusive** boundaries: a block ending exactly on `windowStart`
    // (or starting exactly on `windowEnd`) still overlaps.
    const windowStartDay = windowDayIndex(windowStart);
    const windowEndDay = windowDayIndex(windowEnd);
    return ok(
      collapsed
        .filter(
          (range) =>
            utcDayIndex(range.end) >= windowStartDay && utcDayIndex(range.start) <= windowEndDay,
        )
        .map((range) => ({
          start: formatWallClockIso(range.start),
          end: formatWallClockIso(range.end),
          summary: range.summary,
        })),
    );
  };

  return {
    parseEventRanges,
    collapseToBlockedDateRanges,
  };
};
