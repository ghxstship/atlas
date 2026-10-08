import type { BibleRow } from "../bible.ts";
import { cellOf } from "../bible.ts";
import type { Cell } from "../cell.ts";
import type { Findings } from "../doctrine.ts";
import { canonText } from "../doctrine.ts";
import { normalizeCell, normalizeNumber } from "../normalize.ts";

/**
 * Value helpers shared by the canon models. Text is kept as written (only an
 * em dash is substituted, and reported); numbers use their normalized decimal
 * form; an empty cell is NULL, never an empty string or zero.
 */

export function rawText(cell: Cell): string | null {
  switch (cell.kind) {
    case "empty":
      return null;
    case "string":
      return cell.text.trim() === "" ? null : cell.text;
    case "number":
      return normalizeNumber(Number(cell.text));
    default:
      return normalizeCell(cell);
  }
}

export class RowReader {
  readonly #row: BibleRow;
  readonly #where: string;
  readonly #findings: Findings;

  constructor(row: BibleRow, where: string, findings: Findings) {
    this.#row = row;
    this.#where = where;
    this.#findings = findings;
  }

  get rowNumber(): number {
    return this.#row.row;
  }

  location(column: string): string {
    return `${this.#where} row ${this.#row.row} ${column}`;
  }

  /** Optional text with em dash substitution. */
  opt(column: string): string | null {
    if (!(column in this.#row.cells)) throw new Error(`${this.#where} has no column "${column}"`);
    const cell = cellOf(this.#row, column);
    let v = rawText(cell);
    if (v === null && cell.formula !== undefined) {
      // A statement typed with a leading "=" was saved as a formula with no cached value;
      // its text is the formula source.
      v = cell.formula;
      this.#findings.add(
        "structure",
        this.location(column),
        `Cell is saved as a formula with no value; its text "${v}" is loaded as written.`,
      );
    }
    return v === null ? null : canonText(v, this.location(column), this.#findings);
  }

  /** Required text; a blank cell stops the import. */
  req(column: string): string {
    const v = this.opt(column);
    if (v === null) throw new Error(`${this.location(column)} is blank but required`);
    return v;
  }

  /** Required boolean cell (TRUE or FALSE). */
  bool(column: string): boolean {
    const v = this.req(column);
    if (v === "TRUE") return true;
    if (v === "FALSE") return false;
    throw new Error(`${this.location(column)} is "${v}", not a boolean`);
  }

  /** Optional number in normalized decimal form. */
  num(column: string): string | null {
    const cell = cellOf(this.#row, column);
    if (cell.kind === "empty") return null;
    if (cell.kind !== "number")
      throw new Error(`${this.location(column)} is "${cell.text}", not a number`);
    return normalizeNumber(Number(cell.text));
  }

  /** Required integer. */
  int(column: string): string {
    const v = this.num(column);
    if (v === null || !/^-?[0-9]+$/.test(v))
      throw new Error(`${this.location(column)} is not an integer`);
    return v;
  }

  cell(column: string): Cell {
    return cellOf(this.#row, column);
  }
}

/** Decimal dollars as minor units, without floating point: "1250.5" is 125050. */
export function toMinorUnits(amount: string, exponent = 2): string {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(amount.trim());
  if (!m) throw new Error(`"${amount}" is not a decimal amount`);
  const [, sign, whole, frac = ""] = m;
  if (frac.replace(/0+$/, "").length > exponent)
    throw new Error(`"${amount}" has more than ${exponent} decimals`);
  const digits = `${whole}${frac.padEnd(exponent, "0").slice(0, exponent)}`.replace(
    /^0+(?=[0-9])/,
    "",
  );
  return digits === "0" ? "0" : `${sign}${digits}`;
}

/** Minor units back to a normalized decimal: 125050 is "1250.5". */
export function fromMinorUnits(minor: string, exponent = 2): string {
  const neg = minor.startsWith("-");
  const digits = (neg ? minor.slice(1) : minor).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const frac = digits.slice(digits.length - exponent).replace(/0+$/, "");
  const out = frac === "" ? whole : `${whole}.${frac}`;
  return neg && out !== "0" ? `-${out}` : out;
}
