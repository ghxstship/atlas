import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { columnLetter, columnOrdinal } from "./cell.ts";
import { checksumLines, normalizedRow, sha256, sheetGrid } from "./manifest.ts";
import type { RepoPaths } from "./paths.ts";
import type { CellDiff } from "./roundtrip.ts";
import type { SheetData } from "./workbook.ts";

/**
 * The ruling ledger (canon/map/ruling-differences.yaml). The round trip must
 * reproduce every Playbook cell exactly, except cells an owner ruling changes
 * (decisions D11 to D17, D19; migration report). Each such cell is listed with
 * the ruling, the source value and the value the database now holds, and every
 * entry must still be observed, so the ledger can never hide a new difference.
 */

export const RULINGS = ["D11", "D12", "D13", "D14", "D15", "D16", "D17", "D19"] as const;

export interface LedgerCell {
  readonly sheet: string;
  readonly cell: string;
  readonly ruling: string;
  readonly source: string;
  readonly database: string;
  readonly reason: string;
}

export interface LedgerRow {
  readonly sheet: string;
  readonly row: number;
  readonly ruling: string;
  readonly reason: string;
}

export interface Ledger {
  readonly cells: readonly LedgerCell[];
  readonly removed_rows: readonly LedgerRow[];
}

export function parseLedger(text: string): Ledger {
  const doc = (parse(text) ?? {}) as Partial<Ledger>;
  const ledger = { cells: doc.cells ?? [], removed_rows: doc.removed_rows ?? [] };
  for (const e of [...ledger.cells, ...ledger.removed_rows]) {
    if (!(RULINGS as readonly string[]).includes(e.ruling))
      throw new Error(`Ledger entry for ${e.sheet} names unknown ruling ${e.ruling}`);
    if (!e.reason) throw new Error(`Ledger entry for ${e.sheet} has no reason`);
  }
  return ledger;
}

export function readLedger(paths: RepoPaths): Ledger {
  const file = join(paths.canonMap, "ruling-differences.yaml");
  return existsSync(file)
    ? parseLedger(readFileSync(file, "utf8"))
    : { cells: [], removed_rows: [] };
}

export interface LedgerCheck {
  readonly unexplained: readonly CellDiff[];
  readonly stale: readonly { readonly sheet: string; readonly cell: string }[];
}

export function checkLedger(diffs: readonly CellDiff[], ledger: Ledger): LedgerCheck {
  const usedCells = new Set<LedgerCell>();
  const usedRows = new Set<LedgerRow>();
  const unexplained = diffs.filter((d) => {
    const cell = ledger.cells.find(
      (e) =>
        e.sheet === d.sheet &&
        e.cell === `${d.column}${d.row}` &&
        e.source === d.source &&
        e.database === d.database,
    );
    if (cell) {
      usedCells.add(cell);
      return false;
    }
    const row = ledger.removed_rows.find((e) => e.sheet === d.sheet && e.row === d.row);
    if (row && d.database === "") {
      usedRows.add(row);
      return false;
    }
    return true;
  });
  const stale = [
    ...ledger.cells.filter((e) => !usedCells.has(e)).map((e) => ({ sheet: e.sheet, cell: e.cell })),
    ...ledger.removed_rows
      .filter((e) => !usedRows.has(e))
      .map((e) => ({ sheet: e.sheet, cell: `row ${e.row}` })),
  ];
  return { unexplained, stale };
}

/**
 * Checksum the database export must reproduce: the source sheet with every
 * ledger cell replaced by its ruled value and every removed row dropped.
 */
export function ruledChecksum(sheet: SheetData, ledger: Ledger): string {
  const grid = sheetGrid(sheet);
  const removed = new Set(
    ledger.removed_rows.filter((e) => e.sheet === sheet.name).map((e) => e.row),
  );
  const cells = ledger.cells.filter((e) => e.sheet === sheet.name);
  const rows = grid.dataRows
    .filter((r) => !removed.has(r))
    .map((r) => {
      const values = normalizedRow(sheet, r, grid.columnCount);
      for (const e of cells) {
        const m = /^([A-Z]+)([0-9]+)$/.exec(e.cell);
        if (m && Number(m[2]) === r) values[columnOrdinal(m[1] ?? "A") - 1] = e.database;
      }
      return [String(r), ...values];
    });
  return sha256(checksumLines(grid.headers, rows));
}

/** postgres URL of the local stack, from the [db] port in supabase/config.toml. */
export function localDatabaseUrl(paths: RepoPaths): string {
  const toml = readFileSync(join(paths.root, "supabase", "config.toml"), "utf8");
  const db = toml.slice(toml.indexOf("[db]"));
  const port = /^port\s*=\s*([0-9]+)/m.exec(db)?.[1];
  if (!port) throw new Error("supabase/config.toml has no [db] port");
  return `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
}

export function roundTripReport(diffs: readonly CellDiff[], check: LedgerCheck): string {
  const lines = [
    "# Playbook round trip",
    "",
    `${diffs.length} cells differ between the source Playbook and the database export; ${check.unexplained.length} are not explained by an owner ruling; ${check.stale.length} ledger entries were not observed.`,
    "",
    "| Sheet | Cell | Header | Source | Database | Explained |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const unexplained = new Set(check.unexplained);
  for (const d of diffs) {
    lines.push(
      `| ${d.sheet} | ${d.column}${d.row} | ${d.header} | ${d.source.replace(/\|/g, "\\|")} | ${d.database.replace(/\|/g, "\\|")} | ${unexplained.has(d) ? "no" : "ruling"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export { columnLetter };
