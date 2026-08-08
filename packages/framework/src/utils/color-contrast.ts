/**
 * Linearize an sRGB channel value (0–255) to linear RGB (0–1).
 * @see https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
function linearize(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** WCAG 2.0 relative luminance of an already-parsed color. */
function luminanceOf({ r, g, b }: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Split a hex string into channels WITHOUT validating it.
 *
 * Kept lenient because {@link getContrastColor} has always accepted anything
 * and degraded to a dark result on garbage; tightening that now would be a
 * behavior change for existing callers. New code should prefer
 * {@link parseHex}, which reports failure instead of yielding NaN channels.
 */
function parseHexLoose(hex: string): Rgb {
  const h = hex.replace('#', '');

  if (h.length === 3 || h.length === 4) {
    return {
      r: parseInt(h[0]! + h[0]!, 16),
      g: parseInt(h[1]! + h[1]!, 16),
      b: parseInt(h[2]! + h[2]!, 16),
    };
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Parse `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored), or `null` if the
 * string is not one of those shapes.
 */
function parseHex(hex: string): Rgb | null {
  const h = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  if (h.length !== 3 && h.length !== 4 && h.length !== 6 && h.length !== 8) return null;
  return parseHexLoose(h);
}

function toHex({ r, g, b }: Rgb): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Compute WCAG 2.0 relative luminance from a hex color string.
 * Accepts `#rgb`, `#rrggbb`, or `#rrggbbaa` (alpha is ignored).
 */
function relativeLuminance(hex: string): number {
  return luminanceOf(parseHexLoose(hex));
}

/** WCAG 2.x contrast threshold for normal-size body text. */
export const WCAG_AA_NORMAL_TEXT = 4.5;
/** WCAG 2.x contrast threshold for large text (>=24px, or >=18.66px bold). */
export const WCAG_AA_LARGE_TEXT = 3;

/**
 * WCAG 2.x contrast ratio between two hex colors, from 1 (identical) to 21
 * (black on white). Returns 1 if either color cannot be parsed — callers
 * treating "unparseable" as "fails" would otherwise have to special-case it.
 */
export function getContrastRatio(foreground: string, background: string): number {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) return 1;

  const lf = luminanceOf(fg);
  const lb = luminanceOf(bg);
  const [lighter, darker] = lf > lb ? [lf, lb] : [lb, lf];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Adjust a brand color until it is legible AS TEXT on `background`.
 *
 * A single brand color has to serve two roles that pull in opposite
 * directions: a fill (button, badge) wants the saturated color, while text on
 * the page background wants contrast. A pale brand color can be perfectly good
 * as a fill and still be unreadable as 14px text — a sage `#99A89E` measures
 * 2.48:1 on white, well under the 4.5:1 body-text floor.
 *
 * So this returns a *separate* color for the text role rather than replacing
 * the brand color: the hue is preserved and the color is stepped toward black
 * (or toward white, on a dark background) only as far as it takes to clear
 * `minRatio`. Colors that already pass come back unchanged, so well-chosen
 * brand colors are never touched.
 *
 * Stepping in sRGB rather than OKLCH is deliberate: the WCAG ratio this has to
 * satisfy is itself defined over linearized sRGB, so walking that space hits
 * the threshold exactly, without a perceptual round-trip that could overshoot
 * and darken more than necessary.
 *
 * Pair with {@link getContrastColor}, which answers the opposite question —
 * what color of text to draw ON the brand color.
 *
 * @param hex - The brand color, e.g. `#99A89E`
 * @param background - What the text sits on. Defaults to white.
 * @param minRatio - Target ratio. Defaults to the 4.5:1 body-text threshold.
 * @returns An adjusted hex color, or the input normalized if it already passes.
 *   Unparseable input is returned as-is for the caller to ignore.
 */
export function getReadableTextColor(
  hex: string,
  background = '#ffffff',
  minRatio: number = WCAG_AA_NORMAL_TEXT,
): string {
  const base = parseHex(hex);
  const bg = parseHex(background);
  if (!base || !bg) return hex;

  if (getContrastRatio(toHex(base), toHex(bg)) >= minRatio) return toHex(base);

  // Move away from the background: darken on light backgrounds, lighten on
  // dark ones. 1% steps are far finer than the eye resolves, so the result is
  // the least-adjusted color that clears the bar.
  const target = luminanceOf(bg) > 0.5 ? 0 : 255;
  for (let step = 1; step <= 100; step++) {
    const t = step / 100;
    const candidate = {
      r: base.r + (target - base.r) * t,
      g: base.g + (target - base.g) * t,
      b: base.b + (target - base.b) * t,
    };
    const candidateHex = toHex(candidate);
    if (getContrastRatio(candidateHex, toHex(bg)) >= minRatio) return candidateHex;
  }

  // Pure black or white against a mid-tone background can still fall short of
  // a demanding ratio; hand back the best available rather than nothing.
  return target === 0 ? '#000000' : '#ffffff';
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
