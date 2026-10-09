import type { Cell } from "./cell.ts";
import { EMPTY } from "./cell.ts";
import { normalizeCell } from "./normalize.ts";
import { getCell, lastColumn, rowIsPresent } from "./workbook.ts";
import type { SheetData, WorkbookData } from "./workbook.ts";

/**
 * Bible tabs share one layout: a title on row 1, a subtitle on row 2, the
 * header on row 4 and data rows from row 5 to the first empty row.
 */

export const BIBLE_HEADER_ROW = 4;

export interface BibleRow {
  /** Source row number in the tab. */
  readonly row: number;
  readonly cells: Readonly<Record<string, Cell>>;
}

export interface BibleTable {
  readonly tab: string;
  readonly title: string;
  readonly subtitle: string;
  readonly headers: readonly string[];
  readonly rows: readonly BibleRow[];
}

/** Finds a tab by its number ("06") or full name ("06 · Gate Criteria"). */
export function bibleSheet(workbook: WorkbookData, tab: string): SheetData {
  const found = workbook.sheets.find(
    (s) => s.name === tab || s.name.startsWith(`${tab} `) || s.name.startsWith(`${tab}·`),
  );
  if (!found) throw new Error(`Bible has no tab "${tab}"`);
  return found;
}

/** Header names, with a repeated header suffixed by its column position (record_kind#6). */
export function headerKeys(sheet: SheetData, headerRow: number): string[] {
  const keys: string[] = [];
  const width = lastColumn(sheet, headerRow);
  for (let c = 1; c <= width; c++) {
    const h = normalizeCell(getCell(sheet, headerRow, c));
    const key = h === "" ? `#${c}` : keys.includes(h) ? `${h}#${c}` : h;
    keys.push(key);
  }
  return keys;
}

export function readBibleTable(workbook: WorkbookData, tab: string): BibleTable {
  const sheet = bibleSheet(workbook, tab);
  const headers = headerKeys(sheet, BIBLE_HEADER_ROW);
  const rows: BibleRow[] = [];
  for (let r = BIBLE_HEADER_ROW + 1; rowIsPresent(sheet, r); r++) {
    const cells: Record<string, Cell> = {};
    headers.forEach((h, i) => {
      cells[h] = getCell(sheet, r, i + 1);
    });
    rows.push({ row: r, cells });
  }
  return {
    tab: sheet.name,
    title: normalizeCell(getCell(sheet, 1, 1)),
    subtitle: normalizeCell(getCell(sheet, 2, 1)),
    headers,
    rows,
  };
}

/** Normalized text of a named column; refuses a column the tab does not have. */
export function text(row: BibleRow, column: string): string {
  const cell = row.cells[column];
  if (cell === undefined) throw new Error(`Bible row ${row.row} has no column "${column}"`);
  return normalizeCell(cell);
}

export function cellOf(row: BibleRow, column: string): Cell {
  return row.cells[column] ?? EMPTY;
}
