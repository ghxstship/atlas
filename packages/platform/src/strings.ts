/**
 * String helpers that run in time linear in their input. They replace regular expressions such as /\/+$/, which
 * retry from every position of a long run and so take quadratic time on input an outside party chose.
 */

/** The text without the slashes at its end, as `text.replace(/\/+$/, "")` returns it. */
export function withoutTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  return end === text.length ? text : text.slice(0, end);
}

/**
 * The first `<...>` group of the text with at least one character between the brackets, as /<([^>]+)>/ captures it,
 * or null. Addresses arrive as `Name <address>`.
 */
export function firstAngleGroup(text: string): string | null {
  let from = 0;
  for (;;) {
    const open = text.indexOf("<", from);
    if (open === -1) return null;
    const close = text.indexOf(">", open + 1);
    // No closing bracket after this one means none after any later one either.
    if (close === -1) return null;
    if (close > open + 1) return text.slice(open + 1, close);
    from = close + 1;
  }
}
