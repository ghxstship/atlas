/**
 * Money in integer minor units (Section 3.11). A blank amount is unpriced (null), never zero; a typed
 * zero is a claim. Parsing never goes through floating point multiplication of the whole value.
 */

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** "12.5" with exponent 2 to 1250; "" to null; malformed or too precise to undefined. */
export function toMinor(value: string, exponent: number): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const m = DECIMAL.exec(trimmed);
  if (!m) return undefined;
  const fraction = m[2] ?? "";
  if (fraction.length > exponent) return undefined;
  const minor = Number(`${m[1]}${fraction.padEnd(exponent, "0")}`);
  return Number.isSafeInteger(minor) ? minor : undefined;
}

/** 1250 with exponent 2 to "12.50", for an edit field; null to "". */
export function fromMinor(minor: number | null, exponent: number): string {
  if (minor === null) return "";
  if (exponent === 0) return String(minor);
  const s = String(Math.abs(minor)).padStart(exponent + 1, "0");
  return `${minor < 0 ? "-" : ""}${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}
