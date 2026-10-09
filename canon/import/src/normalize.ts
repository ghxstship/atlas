import type { Cell } from "./cell.ts";

/**
 * Normalized comparison form (Section 2.1): whitespace, number format and date
 * format are normalized; nothing else is. The SQL twins of these functions are
 * xpms.pb_text, xpms.pb_num, xpms.pb_bool and xpms.pb_ts in the playbook views
 * migration, and both sides must stay byte-identical.
 */

const WHITESPACE = /[ \t\n\r\f\v\u00a0]+/g;

export function normalizeText(value: string): string {
  return value.replace(WHITESPACE, " ").trim();
}

/** Ten decimal places, trailing zeros and a bare point removed, never exponent form. */
export function normalizeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Cannot normalize ${value}`);
  const fixed = value.toFixed(10);
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return trimmed === "-0" ? "0" : trimmed;
}

export function normalizeCell(cell: Cell): string {
  switch (cell.kind) {
    case "empty":
      return "";
    case "string":
    case "error":
      return normalizeText(cell.text);
    case "number":
      return normalizeNumber(Number(cell.text));
    case "boolean":
    case "date":
    case "datetime":
    case "time":
      return cell.text;
  }
}
