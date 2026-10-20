/**
 * CSV fields that are safe to open in a spreadsheet (finding A69-005, CWE-1236).
 *
 * Excel, Numbers, LibreOffice and Google Sheets run a cell that starts with `=`, `+`, `-` or `@`
 * (or a tab or carriage return before one) as a formula, so a vendor name such as
 * `=HYPERLINK("https://evil.example","Invoice")` in an export became a live link or a DDE call on
 * the finance team's machine. Every field therefore passes `csvField`: a text value that starts
 * with one of those characters gets a leading apostrophe, the OWASP neutralization, and a plain
 * number such as `-12.50` stays a number. Fields with a quote, comma or line break are quoted as
 * RFC 4180 says.
 */

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The value with a leading apostrophe when a spreadsheet would run it as a formula. */
export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
}

/** One CSV field: neutralized, then quoted when it holds a quote, comma or line break. */
export function csvField(value: string): string {
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
