import { getContrastColor } from './color-contrast.ts';

/** Tailwind 500-shade hex values for color swatch previews */
export const TAILWIND_COLOR_HEX: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#22c55e',
  emerald: '#10b981',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  sky: '#0ea5e9',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#a855f7',
  fuchsia: '#d946ef',
  pink: '#ec4899',
  rose: '#f43f5e',
};

/** All available Tailwind color names */
export const TAILWIND_COLOR_NAMES = Object.keys(TAILWIND_COLOR_HEX);

/**
 * Returns whether light or dark text should be used on a given color background.
 * Accepts both Tailwind color names (e.g. `'amber'`) and hex values (e.g. `'#f59e0b'`).
 * - `'dark'` — bright backgrounds need dark text
 * - `'light'` — dark backgrounds need light/white text
 */
export function getContrastTextMode(color: string): 'light' | 'dark' {
  const hex = color.startsWith('#') ? color : TAILWIND_COLOR_HEX[color];
  if (!hex) return 'light';
  return getContrastColor(hex) === '#ffffff' ? 'light' : 'dark';
}
