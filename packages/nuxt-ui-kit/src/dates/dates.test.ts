import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import {
  calculateDays,
  calculateNights,
  createDateFormatter,
  shiftIso,
  useDateRangeInput,
} from './index.ts';

describe('calculateDays', () => {
  it('counts inclusive days', () => {
    expect(calculateDays({ start: '2025-01-01', end: '2025-01-03' })).toBe(3);
    expect(calculateDays({ start: '2025-01-01', end: '2025-01-01' })).toBe(1);
  });
});

describe('calculateNights', () => {
  it('counts nights with an exclusive end (departure semantics)', () => {
    expect(calculateNights({ start: '2025-01-01', end: '2025-01-03' })).toBe(2);
    expect(calculateNights({ start: '2025-01-01', end: '2025-01-01' })).toBe(0);
    expect(calculateNights({ start: '2027-06-01', end: '2027-06-21' })).toBe(20);
  });

  it('is negative for reversed periods', () => {
    expect(calculateNights({ start: '2025-01-03', end: '2025-01-01' })).toBe(-2);
  });
});

describe('shiftIso', () => {
  it('shifts by days and preserves format', () => {
    expect(shiftIso('2025-01-31', 1)).toBe('2025-02-01');
    expect(shiftIso('2025-01-01', -1)).toBe('2024-12-31');
  });

  it('passes through empty strings and zero shifts', () => {
    expect(shiftIso('', 5)).toBe('');
    expect(shiftIso('2025-01-01', 0)).toBe('2025-01-01');
  });
});

describe('useDateRangeInput', () => {
  it('expands start/end refs into the day interval', () => {
    const start = ref<string | undefined>('2025-03-01');
    const end = ref<string | undefined>('2025-03-03');
    const { dateRange, dayCount } = useDateRangeInput(start, end);
    expect(dayCount.value).toBe(3);
    expect(dateRange.value).toHaveLength(3);
  });

  it('writes back sorted first/last dates on set', () => {
    const start = ref<string | undefined>(undefined);
    const end = ref<string | undefined>(undefined);
    const { dateRange } = useDateRangeInput(start, end);
    dateRange.value = [new Date('2025-03-05'), new Date('2025-03-02'), new Date('2025-03-03')];
    expect(start.value).toBe('2025-03-02');
    expect(end.value).toBe('2025-03-05');
  });

  it('clears both refs on empty set', () => {
    const start = ref<string | undefined>('2025-03-01');
    const end = ref<string | undefined>('2025-03-03');
    const { dateRange } = useDateRangeInput(start, end);
    dateRange.value = [];
    expect(start.value).toBeUndefined();
    expect(end.value).toBeUndefined();
  });

  it('returns an empty range for partial input', () => {
    const start = ref<string | undefined>('2025-03-01');
    const end = ref<string | undefined>(undefined);
    const { dateRange } = useDateRangeInput(start, end);
    expect(dateRange.value).toEqual([]);
  });
});

describe('createDateFormatter', () => {
  const formatter = (locale: string) => createDateFormatter({ getLocale: () => locale });

  it('formats dates per the injected locale', () => {
    expect(formatter('de-DE').formatDate('2025-06-15')).toBe('15.6.2025');
    expect(formatter('en-US').formatDate('2025-06-15')).toBe('6/15/2025');
  });

  it('formatCheckoutDate shifts to the next day by default, not when disabled', () => {
    const f = formatter('de-DE');
    expect(f.formatCheckoutDate('2025-06-15')).toBe('16.6.2025');
    expect(f.formatCheckoutDate('2025-06-15', false)).toBe('15.6.2025');
  });

  it('formatDateMedium returns empty for invalid input', () => {
    expect(formatter('en-US').formatDateMedium('nonsense')).toBe('');
    expect(formatter('en-US').formatDateMedium('2025-06-15')).toContain('Jun');
  });

  it('formats currency with the locale + code', () => {
    expect(formatter('en-US').formatCurrency(1234.5, 'EUR')).toBe('€1,234.50');
  });

  it('reads the locale lazily (reacts to changes)', () => {
    let locale = 'en-US';
    const f = createDateFormatter({ getLocale: () => locale });
    const before = f.formatDate('2025-06-15');
    locale = 'de-DE';
    expect(f.formatDate('2025-06-15')).not.toBe(before);
  });
});
