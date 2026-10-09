import ExcelJS from "exceljs";
import { EMPTY, cellFromPrimitive } from "./cell.ts";
import type { Cell } from "./cell.ts";
import { normalizeCell } from "./normalize.ts";

/**
 * Reads an .xlsx workbook into plain cells with exceljs 4.4.0.
 *
 * Formula cells keep their source formula and their cached result. exceljs
 * drops a zero result from `cell.value`, so results are read from `cell.result`.
 * Cells covered by a merge (other than the anchor) are empty, as in the source
 * grid; the anchor alone carries the value.
 */

export interface SheetData {
  readonly name: string;
  /** 1-based position in the workbook. */
  readonly index: number;
  /** Range of cells holding a value, as exceljs computes it (for example "A1:S6"). */
  readonly usedRange: string;
  readonly mergedRanges: readonly string[];
  /** Sparse grid: row number to column number to cell. */
  readonly rows: ReadonlyMap<number, ReadonlyMap<number, Cell>>;
}

export interface WorkbookData {
  readonly sheets: readonly SheetData[];
}

export function sheetByName(workbook: WorkbookData, name: string): SheetData {
  const sheet = workbook.sheets.find((s) => s.name === name);
  if (!sheet) throw new Error(`Workbook has no sheet named "${name}"`);
  return sheet;
}

export function getCell(sheet: SheetData, row: number, column: number): Cell {
  return sheet.rows.get(row)?.get(column) ?? EMPTY;
}

/** Highest row number holding a non-empty normalized value or a formula. */
export function lastRow(sheet: SheetData): number {
  let last = 0;
  for (const [r, cols] of sheet.rows) {
    for (const cell of cols.values()) {
      if (isPresent(cell) && r > last) last = r;
    }
  }
  return last;
}

/** Highest column number holding a non-empty normalized value or a formula. */
export function lastColumn(sheet: SheetData, fromRow = 1): number {
  let last = 0;
  for (const [r, cols] of sheet.rows) {
    if (r < fromRow) continue;
    for (const [c, cell] of cols) {
      if (isPresent(cell) && c > last) last = c;
    }
  }
  return last;
}

/** A cell is present when it holds a value or a formula. */
export function isPresent(cell: Cell): boolean {
  return cell.formula !== undefined || normalizeCell(cell) !== "";
}

export function rowIsPresent(sheet: SheetData, row: number): boolean {
  const cols = sheet.rows.get(row);
  if (!cols) return false;
  for (const cell of cols.values()) if (isPresent(cell)) return true;
  return false;
}

type ExcelValue = ExcelJS.CellValue;

function richTextOf(value: { richText: { text: string }[] }): string {
  return value.richText.map((part) => part.text).join("");
}

/** Converts an exceljs value (never a formula value) into a cell. */
export function cellFromValue(value: ExcelValue, formula?: string): Cell {
  if (value === null || value === undefined) return cellFromPrimitive(null, formula);
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  ) {
    return cellFromPrimitive(value, formula);
  }
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return cellFromPrimitive(richTextOf(value), formula);
    }
    if ("error" in value && typeof value.error === "string") {
      const extra = formula === undefined ? {} : { formula };
      return { kind: "error", text: value.error, ...extra };
    }
    if ("hyperlink" in value && "text" in value) {
      const text = value.text;
      if (typeof text === "string") return cellFromPrimitive(text, formula);
      if (text && typeof text === "object" && "richText" in text) {
        return cellFromPrimitive(richTextOf(text), formula);
      }
    }
  }
  throw new TypeError(`Unsupported cell value ${JSON.stringify(value)}`);
}

export function cellFromExcel(cell: ExcelJS.Cell): Cell {
  if (cell.type === ExcelJS.ValueType.Formula) {
    const source = cell.formula;
    if (typeof source !== "string" || source.length === 0) {
      throw new Error(`Formula cell ${cell.address} has no formula text`);
    }
    return cellFromValue(cell.result as ExcelValue, `=${source}`);
  }
  return cellFromValue(cell.value);
}

export async function readWorkbook(path: string): Promise<WorkbookData> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheets: SheetData[] = [];
  workbook.worksheets.forEach((ws, i) => {
    const rows = new Map<number, Map<number, Cell>>();
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const value = cellFromExcel(cell);
        if (value.kind === "empty" && value.formula === undefined) return;
        let cols = rows.get(r);
        if (!cols) {
          cols = new Map();
          rows.set(r, cols);
        }
        cols.set(c, value);
      });
    });
    const merges = (ws.model as { merges?: string[] }).merges ?? [];
    const dims = ws.dimensions as unknown as { range?: string } | undefined;
    sheets.push({
      name: ws.name,
      index: i + 1,
      usedRange: dims?.range ?? "",
      mergedRanges: [...merges].sort(),
      rows,
    });
  });
  return { sheets };
}
