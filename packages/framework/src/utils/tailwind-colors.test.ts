import { describe, it, expect } from 'vitest';
import { TAILWIND_COLOR_HEX, TAILWIND_COLOR_NAMES, getContrastTextMode } from './tailwind-colors.ts';

describe('TAILWIND_COLOR_HEX', () => {
  it('every value is a well-formed 6-digit hex color', () => {
    for (const [name, hex] of Object.entries(TAILWIND_COLOR_HEX)) {
      expect(hex, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('TAILWIND_COLOR_NAMES is exactly the map keys', () => {
    expect(TAILWIND_COLOR_NAMES).toEqual(Object.keys(TAILWIND_COLOR_HEX));
  });

  it('has no duplicate names or hex values', () => {
    expect(new Set(TAILWIND_COLOR_NAMES).size).toBe(TAILWIND_COLOR_NAMES.length);
    const hexValues = Object.values(TAILWIND_COLOR_HEX);
    expect(new Set(hexValues).size).toBe(hexValues.length);
  });
});

describe('getContrastTextMode', () => {
  it('resolves a Tailwind color name to light mode for a dark-ish swatch', () => {
    // #ef4444 (red) is known (color-contrast.test.ts) to pair with white text
    expect(getContrastTextMode('red')).toBe('light');
    expect(getContrastTextMode('blue')).toBe('light');
  });

  it('resolves a Tailwind color name to dark mode for a bright swatch', () => {
    // #f59e0b (amber) / #eab308 (yellow) are known to pair with dark text
    expect(getContrastTextMode('amber')).toBe('dark');
    expect(getContrastTextMode('yellow')).toBe('dark');
  });

  it('accepts a raw hex value directly, bypassing the name lookup', () => {
    expect(getContrastTextMode('#ef4444')).toBe('light');
    expect(getContrastTextMode('#eab308')).toBe('dark');
  });

  it('defaults to light mode for an unrecognized color name', () => {
    expect(getContrastTextMode('not-a-color')).toBe('light');
    expect(getContrastTextMode('')).toBe('light');
  });
});
