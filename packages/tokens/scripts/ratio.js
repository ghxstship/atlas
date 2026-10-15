/* WCAG 2.2 contrast arithmetic, browser-safe: no Node imports, so the ColorPicker and the
   white-label theme editor share the exact calculation the contrast gate (check-contrast.js) runs. */

function lin(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a hex color (#rgb or #rrggbb). */
export function luminance(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, "$&$&");
  return (
    0.2126 * lin(parseInt(h.substring(0, 2), 16)) +
    0.7152 * lin(parseInt(h.substring(2, 4), 16)) +
    0.0722 * lin(parseInt(h.substring(4, 6), 16))
  );
}

/** WCAG 2.2 contrast ratio between two hex colors. */
export function ratio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
