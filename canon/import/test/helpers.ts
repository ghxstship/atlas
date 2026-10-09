import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { defaultRoot, repoPaths } from "../src/paths.ts";

export const ROOT = defaultRoot();
export const PATHS = repoPaths(ROOT);

export function tempDir(prefix = "canon-import-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export type FixtureValue = ExcelJS.CellValue;

/** Writes a workbook whose sheets are given as row arrays (row 1 first). */
export async function writeFixture(
  path: string,
  sheets: Record<string, readonly (readonly FixtureValue[])[]>,
  configure?: (wb: ExcelJS.Workbook) => void,
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((row, i) => {
      row.forEach((value, j) => {
        if (value !== null && value !== undefined) ws.getCell(i + 1, j + 1).value = value;
      });
    });
  }
  configure?.(wb);
  await wb.xlsx.writeFile(path);
  return path;
}
