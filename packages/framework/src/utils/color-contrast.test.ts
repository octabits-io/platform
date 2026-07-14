import { describe, expect, it } from 'vitest';
import { getContrastColor } from './color-contrast.ts';

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
});
