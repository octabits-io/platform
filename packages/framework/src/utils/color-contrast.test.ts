import { describe, expect, it } from 'vitest';
import {
  getContrastColor,
  getContrastRatio,
  getReadableTextColor,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
} from './color-contrast.ts';

describe('getContrastColor', () => {
  it('returns white for dark backgrounds', () => {
    expect(getContrastColor('#000000')).toBe('#ffffff');
    expect(getContrastColor('#1e3a5f')).toBe('#ffffff'); // dark navy
    expect(getContrastColor('#3b82f6')).toBe('#ffffff'); // blue-500
    expect(getContrastColor('#6366f1')).toBe('#ffffff'); // indigo-500
    expect(getContrastColor('#ef4444')).toBe('#ffffff'); // red-500
    expect(getContrastColor('#729388')).toBe('#ffffff'); // muted teal-green primary
  });

  it('returns dark for bright backgrounds', () => {
    expect(getContrastColor('#ffffff')).toBe('#1a1a1a');
    expect(getContrastColor('#f59e0b')).toBe('#1a1a1a'); // amber-500
    expect(getContrastColor('#eab308')).toBe('#1a1a1a'); // yellow-500
    expect(getContrastColor('#84cc16')).toBe('#1a1a1a'); // lime-500
    expect(getContrastColor('#22c55e')).toBe('#1a1a1a'); // green-500
  });

  it('handles shorthand hex (#rgb)', () => {
    expect(getContrastColor('#000')).toBe('#ffffff');
    expect(getContrastColor('#fff')).toBe('#1a1a1a');
  });

  it('handles hex with alpha (#rrggbbaa)', () => {
    expect(getContrastColor('#000000ff')).toBe('#ffffff');
    expect(getContrastColor('#ffffffcc')).toBe('#1a1a1a');
  });

  it('still degrades to dark on unparseable input', () => {
    // Long-standing lenient behavior — the refactor to shared parsing helpers
    // must not turn this into a throw or a different color.
    expect(getContrastColor('not-a-color')).toBe('#1a1a1a');
    expect(getContrastColor('')).toBe('#1a1a1a');
  });
});

describe('getContrastRatio', () => {
  it('spans the full WCAG range', () => {
    expect(getContrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(getContrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('is symmetric in its arguments', () => {
    expect(getContrastRatio('#99a89e', '#ffffff')).toBeCloseTo(
      getContrastRatio('#ffffff', '#99a89e'),
      10,
    );
  });

  it('matches the ratio browsers report for a pale sage on white', () => {
    expect(getContrastRatio('#99a89e', '#ffffff')).toBeCloseTo(2.48, 1);
  });

  it('returns 1 for unparseable input rather than throwing', () => {
    expect(getContrastRatio('not-a-color', '#ffffff')).toBe(1);
    expect(getContrastRatio('#ffffff', 'rgb(0,0,0)')).toBe(1);
  });
});

describe('getReadableTextColor', () => {
  it('leaves colors that already pass untouched', () => {
    expect(getReadableTextColor('#1d4ed8')).toBe('#1d4ed8'); // blue-700, 6.7:1
    expect(getReadableTextColor('#000000')).toBe('#000000');
  });

  it('darkens a pale brand color on white until it clears 4.5:1', () => {
    const result = getReadableTextColor('#99a89e');
    expect(result).not.toBe('#99a89e');
    expect(getContrastRatio(result, '#ffffff')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it('adjusts no further than necessary', () => {
    const ratio = getContrastRatio(getReadableTextColor('#99a89e'), '#ffffff');
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(ratio).toBeLessThan(WCAG_AA_NORMAL_TEXT + 0.6);
  });

  it('preserves hue ordering while darkening', () => {
    const hex = getReadableTextColor('#99a89e').replace('#', '');
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('lightens instead of darkening on a dark background', () => {
    const result = getReadableTextColor('#1d4ed8', '#111111');
    expect(getContrastRatio(result, '#111111')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(getContrastRatio(result, '#ffffff')).toBeLessThan(getContrastRatio('#1d4ed8', '#ffffff'));
  });

  it('honours a lower threshold for large text', () => {
    const large = getReadableTextColor('#99a89e', '#ffffff', WCAG_AA_LARGE_TEXT);
    const normal = getReadableTextColor('#99a89e', '#ffffff', WCAG_AA_NORMAL_TEXT);
    expect(getContrastRatio(large, '#ffffff')).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    expect(getContrastRatio(large, '#ffffff')).toBeLessThan(getContrastRatio(normal, '#ffffff'));
  });

  it('returns unparseable input unchanged', () => {
    expect(getReadableTextColor('nope')).toBe('nope');
  });

  it('handles shorthand hex', () => {
    expect(getContrastRatio(getReadableTextColor('#9a9'), '#ffffff'))
      .toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it('complements getContrastColor rather than duplicating it', () => {
    // Two different questions about the same sage. getContrastColor asks what
    // goes ON it as a fill — it is light, so dark text. getReadableTextColor
    // asks what it becomes when it IS the text on white — too pale at 2.48:1,
    // so darkened to clear 4.5:1.
    expect(getContrastColor('#99a89e')).toBe('#1a1a1a');
    expect(getReadableTextColor('#99a89e')).toBe('#6e7972');
  });
});
