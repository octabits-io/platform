// ============================================================================
// @octabits-io/foundation/ical — iCal ingestion: fetcher + parser
// ============================================================================
//
// Two independent services, single `.` entry:
//
//   createICalFetcherService — fetch iCal over http(s)/webcal with a timeout
//     and size cap, strip DTSTAMP, and hash for change detection.
//   createICalParserService  — parse VEVENTs and expand RRULEs into raw event
//     ranges (base API), with an optional day-blocking collapse layer.
//
// Errors are `@octabits-io/foundation` `Result`/`OctError`; keys are `ical_*`.

// --- Fetcher ----------------------------------------------------------------
export { createICalFetcherService } from './ICalFetcherService.ts';
export type {
  ICalFetcherService,
  CreateICalFetcherServiceParams,
  ICalFetchResult,
  ICalFetchError,
} from './ICalFetcherService.ts';

// --- Parser -----------------------------------------------------------------
export { createICalParserService } from './ICalParserService.ts';
export type {
  ICalParserService,
  CreateICalParserServiceParams,
  ICalEventRange,
  ICalWallClock,
  ParseEventRangesOptions,
  BlockedDateRange,
  CollapseToBlockedDateRangesOptions,
} from './ICalParserService.ts';
