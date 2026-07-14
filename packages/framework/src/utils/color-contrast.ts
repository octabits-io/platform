/**
 * Linearize an sRGB channel value (0–255) to linear RGB (0–1).
 * @see https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
function linearize(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/**
 * Compute WCAG 2.0 relative luminance from a hex color string.
 * Accepts `#rgb`, `#rrggbb`, or `#rrggbbaa` (alpha is ignored).
 */
function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  let r: number, g: number, b: number;

  if (h.length === 3 || h.length === 4) {
    r = parseInt(h[0]! + h[0]!, 16);
    g = parseInt(h[1]! + h[1]!, 16);
    b = parseInt(h[2]! + h[2]!, 16);
  } else {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }

  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

const WHITE_LUMINANCE = 1;
const DARK_LUMINANCE = 0.01656; // #1a1a1a

/**
 * Returns white or dark text color for readable contrast on the given background.
 *
 * Compares WCAG contrast ratios against white (#ffffff) and dark (#1a1a1a),
 * picking whichever gives better readability. A slight bias toward white text
 * is applied to match common design conventions where white-on-colored
 * is preferred at borderline luminance values.
 *
 * @param hex - Background color as hex string (e.g. `#3b82f6`)
 * @returns `'#ffffff'` for dark backgrounds, `'#1a1a1a'` for bright backgrounds
 */
export function getContrastColor(hex: string): string {
  const bgL = relativeLuminance(hex);

  const contrastWithWhite = (WHITE_LUMINANCE + 0.05) / (bgL + 0.05);
  const contrastWithDark = (bgL + 0.05) / (DARK_LUMINANCE + 0.05);

  // Bias factor favors white text at borderline luminance (common design convention).
  // Without this, colors like blue-500 (#3b82f6) would get dark text despite white being
  // the universal convention for solid blue buttons. The 1.5 bias also pushes muted
  // mid-tone primaries (e.g. #729388) toward white — pure WCAG luminance math prefers
  // dark text there, but every mainstream design system uses white on filled CTAs.
  return contrastWithWhite * 1.5 >= contrastWithDark ? '#ffffff' : '#1a1a1a';
}
