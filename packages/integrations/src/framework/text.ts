/** Text helpers with no imports, so a function that needs one of them bundles nothing else. */

/**
 * The text without the run of one character at its end, as `text.replace(/x+$/, "")` returns it. One pass from the
 * end: the pattern retries from every position of a long run, which is quadratic on text a caller chose.
 */
export function withoutTrailing(text: string, character: string): string {
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === character) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** The text without the run of one character at its start. */
export function withoutLeading(text: string, character: string): string {
  let start = 0;
  while (start < text.length && text.charAt(start) === character) start++;
  return start === 0 ? text : text.slice(start);
}
