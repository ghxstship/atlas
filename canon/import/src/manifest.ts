import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { columnLetter } from "./cell.ts";
import { normalizeCell } from "./normalize.ts";
import { destinationOf, headerRowOf } from "./playbook/layout.ts";
import type { Destination } from "./playbook/layout.ts";
import { SOURCE_FILES } from "./sources.ts";
import { getCell, lastColumn, rowIsPresent } from "./workbook.ts";
import type { SheetData, WorkbookData } from "./workbook.ts";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface FileManifestEntry {
  readonly file: string;
  readonly role: string;
  readonly reference_only: boolean;
  readonly bytes: number;
  readonly sha256: string;
  readonly drive_file_id: string;
  readonly drive_modified_time: string;
}

export interface FileManifest {
  readonly generator: string;
  readonly files: readonly FileManifestEntry[];
}

export const GENERATOR = "@xos/canon-import";

export function buildFileManifest(sourceDir: string): FileManifest {
  const files = SOURCE_FILES.map((s) => {
    const bytes = readFileSync(join(sourceDir, s.file));
    return {
      file: s.file,
      role: s.role,
      reference_only: s.referenceOnly,
      bytes: bytes.length,
      sha256: sha256(bytes),
      drive_file_id: s.driveFileId,
      drive_modified_time: s.driveModifiedTime,
    };
  });
  return { generator: GENERATOR, files };
}

/** Compares recorded hashes with the bytes on disk; returns one message per mismatch. */
export function verifyFileManifest(recorded: FileManifest, sourceDir: string): string[] {
  const current = buildFileManifest(sourceDir);
  const problems: string[] = [];
  for (const now of current.files) {
    const was = recorded.files.find((f) => f.file === now.file);
    if (!was) problems.push(`${now.file} is not recorded in MANIFEST.json`);
    else if (was.sha256 !== now.sha256) {
      problems.push(`${now.file} changed: recorded ${was.sha256}, on disk ${now.sha256}`);
    }
  }
  for (const was of recorded.files) {
    if (!current.files.some((f) => f.file === was.file))
      problems.push(`${was.file} is recorded but not registered`);
  }
  return problems;
}

export interface ColumnManifest {
  readonly ordinal: number;
  readonly letter: string;
  readonly header: string;
}

export interface SheetManifest {
  readonly name: string;
  readonly index: number;
  readonly destination: Destination;
  readonly used_range: string;
  readonly header_row: number | null;
  readonly columns: readonly ColumnManifest[];
  readonly data_row_count: number;
  readonly first_data_row: number | null;
  readonly last_data_row: number | null;
  readonly formula_cell_count: number;
  readonly merged_ranges: readonly string[];
  readonly checksum_sha256: string;
}

export interface PlaybookManifest {
  readonly generator: string;
  readonly source_file: string;
  readonly source_sha256: string;
  readonly normalization: string;
  readonly sheets: readonly SheetManifest[];
}

export const NORMALIZATION =
  "Whitespace runs collapse to one space and are trimmed; numbers print with up to ten decimals and no exponent; dates print as YYYY-MM-DD, date-times as YYYY-MM-DDTHH:MM:SS and times as HH:MM:SS; booleans print as TRUE or FALSE; formula cells use their cached result. The checksum is SHA-256 over the JSON header array followed by one JSON array per data row holding the row number and every normalized cell, joined by line feeds.";

export interface SheetGrid {
  readonly headerRow: number | null;
  readonly columnCount: number;
  readonly headers: readonly string[];
  readonly dataRows: readonly number[];
}

/** Header, column count and data rows of a sheet, as the manifest defines them. */
export function sheetGrid(sheet: SheetData): SheetGrid {
  const headerRow = headerRowOf(sheet.name);
  const columnCount = lastColumn(sheet);
  const headers: string[] = [];
  for (let c = 1; c <= columnCount; c++) {
    headers.push(headerRow === null ? "" : normalizeCell(getCell(sheet, headerRow, c)));
  }
  const firstData = headerRow === null ? 1 : headerRow + 1;
  const dataRows = [...sheet.rows.keys()]
    .filter((r) => r >= firstData && rowIsPresent(sheet, r))
    .sort((a, b) => a - b);
  return { headerRow, columnCount, headers, dataRows };
}

export function normalizedRow(sheet: SheetData, row: number, columnCount: number): string[] {
  const out: string[] = [];
  for (let c = 1; c <= columnCount; c++) out.push(normalizeCell(getCell(sheet, row, c)));
  return out;
}

/** The checksum lines: the header array, then [row, ...cells] per data row. */
export function checksumLines(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [JSON.stringify(headers)];
  for (const r of rows) lines.push(JSON.stringify(r));
  return lines.join("\n");
}

export function sheetChecksum(sheet: SheetData, grid: SheetGrid = sheetGrid(sheet)): string {
  const rows = grid.dataRows.map((r) => [String(r), ...normalizedRow(sheet, r, grid.columnCount)]);
  return sha256(checksumLines(grid.headers, rows));
}

export function buildSheetManifest(sheet: SheetData): SheetManifest {
  const grid = sheetGrid(sheet);
  if (grid.headerRow !== null) {
    grid.headers.forEach((h, i) => {
      if (h === "")
        throw new Error(`${sheet.name} column ${columnLetter(i + 1)} holds data but has no header`);
    });
  }
  let formulas = 0;
  for (const cols of sheet.rows.values()) {
    for (const cell of cols.values()) if (cell.formula !== undefined) formulas += 1;
  }
  return {
    name: sheet.name,
    index: sheet.index,
    destination: destinationOf(sheet.name),
    used_range: sheet.usedRange,
    header_row: grid.headerRow,
    columns: grid.headers.map((header, i) => ({
      ordinal: i + 1,
      letter: columnLetter(i + 1),
      header,
    })),
    data_row_count: grid.dataRows.length,
    first_data_row: grid.dataRows[0] ?? null,
    last_data_row: grid.dataRows[grid.dataRows.length - 1] ?? null,
    formula_cell_count: formulas,
    merged_ranges: sheet.mergedRanges,
    checksum_sha256: sheetChecksum(sheet, grid),
  };
}

export function buildPlaybookManifest(
  workbook: WorkbookData,
  sourceFile: string,
  sourceSha: string,
): PlaybookManifest {
  return {
    generator: GENERATOR,
    source_file: sourceFile,
    source_sha256: sourceSha,
    normalization: NORMALIZATION,
    sheets: workbook.sheets.map(buildSheetManifest),
  };
}

export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
