/**
 * Cell model shared by the xlsx and CSV readers.
 *
 * `text` is the lossless storage form of the value (what the seed writes). The
 * normalized comparison form lives in normalize.ts and is used only for
 * manifests, cross-checks and the round-trip proof.
 */

export type CellKind =
  "empty" | "string" | "number" | "boolean" | "date" | "datetime" | "time" | "error";

export interface Cell {
  readonly kind: CellKind;
  /** Lossless text form: ISO dates, shortest round-trip numbers, TRUE or FALSE. */
  readonly text: string;
  /** Formula source including the leading "=", when the cell holds a formula. */
  readonly formula?: string;
}

export const EMPTY: Cell = Object.freeze({ kind: "empty", text: "" });

/** Column letters for a 1-based ordinal: 1 is A, 27 is AA. */
export function columnLetter(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`Column ordinal must be a positive integer, got ${ordinal}`);
  }
  let n = ordinal;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 1-based ordinal for column letters: A is 1, AA is 27. */
export function columnOrdinal(letters: string): number {
  if (!/^[A-Z]+$/.test(letters)) {
    throw new RangeError(`Column letters must be A to Z, got "${letters}"`);
  }
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Spreadsheet dates are zone-less wall times. exceljs returns them as Date
 * objects whose UTC fields carry the wall time, so every field is read in UTC.
 * Time-only values sit on the 1899-12-30 epoch day.
 */
export function cellFromDate(value: Date, formula?: string): Cell {
  const rounded = new Date(Math.round(value.getTime() / 1000) * 1000);
  const y = rounded.getUTCFullYear();
  const mo = rounded.getUTCMonth() + 1;
  const d = rounded.getUTCDate();
  const h = rounded.getUTCHours();
  const mi = rounded.getUTCMinutes();
  const s = rounded.getUTCSeconds();
  const time = `${pad(h)}:${pad(mi)}:${pad(s)}`;
  const extra = formula === undefined ? {} : { formula };
  if (y < 1900) {
    return { kind: "time", text: time, ...extra };
  }
  const date = `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
  if (h === 0 && mi === 0 && s === 0) return { kind: "date", text: date, ...extra };
  return { kind: "datetime", text: `${date}T${time}`, ...extra };
}

export function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Non-finite number ${value}`);
  return Object.is(value, -0) ? "0" : String(value);
}

export function cellFromPrimitive(value: unknown, formula?: string): Cell {
  const extra = formula === undefined ? {} : { formula };
  if (value === null || value === undefined)
    return formula === undefined ? EMPTY : { kind: "empty", text: "", formula };
  if (typeof value === "string") return { kind: "string", text: value, ...extra };
  if (typeof value === "number") return { kind: "number", text: numberText(value), ...extra };
  if (typeof value === "boolean")
    return { kind: "boolean", text: value ? "TRUE" : "FALSE", ...extra };
  if (value instanceof Date) return cellFromDate(value, formula);
  throw new TypeError(`Unsupported primitive cell value of type ${typeof value}`);
}
