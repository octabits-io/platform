---
'@octabits-io/framework': minor
---

**`./utils`: add `getReadableTextColor` and `getContrastRatio`.** A single brand
color has to serve two roles that pull in opposite directions — a fill wants the
saturated color, text on the page background wants contrast — and one value
cannot satisfy both. A sage `#99A89E` is perfectly good on a button and measures
2.48:1 as 14px text on white, well under the 4.5:1 floor. `getContrastColor`
already answers "what goes ON this color"; nothing answered "what does this
color become when it IS the text".

`getReadableTextColor(hex, background?, minRatio?)` returns the least-adjusted
version of a color that clears the ratio: hue preserved, stepped toward black on
a light background or toward white on a dark one, and returned unchanged when it
already passes — so well-chosen brand colors are never touched. `#99A89E` on
white becomes `#6e7972` at 4.52:1. Consumers are expected to keep the raw brand
color for fills and route only the text role through this, rather than replacing
the color globally.

Stepping happens in sRGB, not OKLCH, because the WCAG ratio being satisfied is
itself defined over linearized sRGB — walking that space lands on the threshold
exactly instead of overshooting through a perceptual round-trip.

`getContrastRatio(foreground, background)` exposes the underlying WCAG 2.x ratio
(1–21) so callers can decide for themselves, e.g. to warn an operator that their
chosen color will be substituted. It returns `1` rather than `NaN` for
unparseable input, so "cannot parse" reads as "fails" without a special case.
`WCAG_AA_NORMAL_TEXT` (4.5) and `WCAG_AA_LARGE_TEXT` (3) are exported alongside.

`getContrastColor` is unchanged in behavior. Internally it now shares the
parsing and luminance helpers, and it deliberately keeps its lenient handling of
malformed input — it has always degraded to the dark result rather than
throwing, and a regression test pins that. The new functions use a strict parser
that reports failure instead.
