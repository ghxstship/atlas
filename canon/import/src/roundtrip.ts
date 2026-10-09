import ExcelJS from "exceljs";
import pg from "pg";
import { columnLetter } from "./cell.ts";
import { normalizedRow, sheetGrid } from "./manifest.ts";
import { normalizeCell } from "./normalize.ts";
import { sheetKey } from "./playbook/layout.ts";
import { getCell, readWorkbook, sheetByName } from "./workbook.ts";
import type { WorkbookData } from "./workbook.ts";

/**
 * Round-trip proof (Section 2.1, Section 18 gate 14). Every sheet is exported
 * from the database through xpms.v_playbook_<sheet>, written to .xlsx, read
 * back, and compared with the source workbook cell by cell after normalizing
 * whitespace, number format and date format.
 */

export interface ExportedSheet {
  readonly name: string;
  readonly headers: readonly string[];
  readonly rows: readonly { readonly row: number; readonly cells: readonly string[] }[];
}

export interface CellDiff {
  readonly sheet: string;
  readonly row: number;
  readonly column: string;
  readonly header: string;
  readonly source: string;
  readonly database: string;
}

export async function exportFromDatabase(
  client: pg.Client,
  sheets: readonly string[],
): Promise<ExportedSheet[]> {
  const out: ExportedSheet[] = [];
  for (const name of sheets) {
    const headers = await client.query<{ header: string | null }>(
      "select header from xpms.playbook_column where sheet_name = $1 order by ordinal",
      [name],
    );
    const rows = await client.query<{ source_row: number; cells: string[] }>(
      `select source_row, cells from xpms.v_playbook_${sheetKey(name)} order by source_row`,
    );
    out.push({
      name,
      headers: headers.rows.map((h) => h.header ?? ""),
      rows: rows.rows.map((r) => ({ row: r.source_row, cells: r.cells })),
    });
  }
  return out;
}

/** Writes the exported sheets to .xlsx at their source row positions, header on row 1. */
export async function writeExport(
  sheets: readonly ExportedSheet[],
  path: string,
  coverSheet: string,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    if (s.name !== coverSheet) s.headers.forEach((h, i) => (ws.getCell(1, i + 1).value = h));
    for (const r of s.rows) {
      r.cells.forEach((v, i) => {
        if (v !== "") ws.getCell(r.row, i + 1).value = v;
      });
    }
  }
  await wb.xlsx.writeFile(path);
}

/** Compares an exported workbook (text cells) with the source workbook, cell by cell. */
export function compareWorkbooks(
  source: WorkbookData,
  exported: WorkbookData,
  sheets: readonly string[],
): CellDiff[] {
  const diffs: CellDiff[] = [];
  for (const name of sheets) {
    const src = sheetByName(source, name);
    const grid = sheetGrid(src);
    const out = sheetByName(exported, name);
    const exportedRows = new Set<number>(
      [...out.rows.keys()].filter((r) => r !== (grid.headerRow ?? 0)),
    );
    for (let c = 1; c <= grid.columnCount; c++) {
      if (grid.headerRow !== null) {
        const h = normalizeCell(getCell(out, grid.headerRow, c));
        if (h !== grid.headers[c - 1]) {
          diffs.push({
            sheet: name,
            row: grid.headerRow,
            column: columnLetter(c),
            header: "(header)",
            source: grid.headers[c - 1] ?? "",
            database: h,
          });
        }
      }
    }
    const rows = new Set<number>([...grid.dataRows, ...exportedRows]);
    for (const r of [...rows].sort((a, b) => a - b)) {
      const want = normalizedRow(src, r, grid.columnCount);
      for (let c = 1; c <= grid.columnCount; c++) {
        const got = normalizeCell(getCell(out, r, c));
        const expected = want[c - 1] ?? "";
        if (got !== expected) {
          diffs.push({
            sheet: name,
            row: r,
            column: columnLetter(c),
            header: grid.headers[c - 1] ?? "",
            source: expected,
            database: got,
          });
        }
      }
    }
  }
  return diffs;
}

export async function roundTrip(
  connection: string,
  sourcePath: string,
  exportPath: string,
  coverSheet: string,
): Promise<CellDiff[]> {
  const source = await readWorkbook(sourcePath);
  const names = source.sheets.map((s) => s.name);
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  try {
    const exported = await exportFromDatabase(client, names);
    await writeExport(exported, exportPath, coverSheet);
  } finally {
    await client.end();
  }
  return compareWorkbooks(source, await readWorkbook(exportPath), names);
}
