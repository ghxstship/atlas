import type { Cell } from "../cell.ts";
import { columnLetter } from "../cell.ts";
import type { Findings } from "../doctrine.ts";
import { canonText } from "../doctrine.ts";
import { sheetChecksum, sheetGrid } from "../manifest.ts";
import type { IntakeRow } from "../model/bible-model.ts";
import { rawText, toMinorUnits } from "../model/values.ts";
import { normalizeCell, normalizeNumber, normalizeText } from "../normalize.ts";
import type { SqlRow } from "../sql.ts";
import { getCell, sheetByName } from "../workbook.ts";
import type { SheetData, WorkbookData } from "../workbook.ts";
import type { ColumnMap, SheetEntry } from "./column-map.ts";
import { COVER_SHEET } from "./layout.ts";
import { MIRRORS } from "./mirror.ts";
import type { MirrorContext } from "./mirror.ts";
import { stdColumnName, stdTableSpec } from "./tables.ts";

export const TEMPLATE_CODE = "XOS-4.0";
export const PLAYBOOK_FILE = "XOS-4.0_Production-Playbook_2026.xlsx";

export type DiffKind = "value" | "playbook-only-row" | "bible-only-row" | "library-conflict";

export interface DiffEntry {
  readonly kind: DiffKind;
  readonly sheet: string;
  readonly row: number | null;
  readonly column: string;
  readonly key: string;
  readonly bible: string | null;
  readonly playbook: string | null;
  readonly note: string;
}

export interface RealWorldRow {
  readonly sheet: string;
  readonly row: number;
  readonly id: string;
  readonly columns: readonly string[];
}

export interface PlaybookResult {
  readonly tables: Map<string, SqlRow[]>;
  readonly intake: IntakeRow[];
  readonly diff: DiffEntry[];
  readonly realWorld: RealWorldRow[];
}

function same(a: string | null, b: string | null): boolean {
  const x = normalizeText(a ?? "");
  const y = normalizeText(b ?? "");
  if (x === y) return true;
  return (
    x !== "" &&
    y !== "" &&
    /^-?[0-9.]+$/.test(x) &&
    /^-?[0-9.]+$/.test(y) &&
    Number(x) === Number(y)
  );
}

/** Lossless text of a Playbook cell for storage, with em dash substitution reported. */
function cellText(cell: Cell, where: string, findings: Findings): string | null {
  const v = rawText(cell);
  return v === null ? null : canonText(v, where, findings);
}

function entryFor(map: ColumnMap, sheet: string): SheetEntry {
  const e = map.sheets.find((s) => s.sheet === sheet);
  if (!e) throw new Error(`Column map has no sheet ${sheet}`);
  return e;
}

function intakeRow(
  sheet: string,
  row: number,
  header: string,
  target: { table: string; key: string; column: string },
  proposed: string | null,
  canon: string | null,
  reason: string,
): IntakeRow {
  return {
    source_file: PLAYBOOK_FILE,
    source_sheet: sheet,
    source_row: String(row),
    source_column: header,
    target_table: target.table,
    target_key: target.key,
    target_column: target.column,
    proposed_value: proposed,
    canon_value: canon,
    reason,
    intake_state: "Proposed",
  };
}

function applyMirrors(
  playbook: WorkbookData,
  tables: Map<string, SqlRow[]>,
  intake: IntakeRow[],
  diff: DiffEntry[],
  findings: Findings,
): void {
  const csvIntake = new Map<string, string | null>();
  for (const i of intake)
    if (i.source_column === "default_phase") csvIntake.set(i.target_key, i.proposed_value);
  const ctx: MirrorContext = { tables, csvIntake };
  const balances = new Map<string, Set<string>>();
  for (const spec of MIRRORS) {
    const sheet = sheetByName(playbook, spec.sheet);
    const grid = sheetGrid(sheet);
    const keyIndex = grid.headers.indexOf(spec.keyHeader);
    if (keyIndex < 0) throw new Error(`${spec.sheet} has no ${spec.keyHeader} column`);
    for (const h of grid.headers) {
      if (!(h in spec.columns)) throw new Error(`${spec.sheet} column ${h} has no mirror mapping`);
    }
    const rows = [...(tables.get(spec.table) ?? [])].map((r) => ({ ...r }));
    const seen = new Set<string>();
    for (const r of grid.dataRows) {
      const keyValue = normalizeCell(getCell(sheet, r, keyIndex + 1));
      const canonRow = rows.find((x) => same(x[spec.keyColumn] as string | null, keyValue));
      const key = canonRow ? String(canonRow[spec.keyColumn]) : keyValue;
      seen.add(key);
      if (canonRow) canonRow["source_row"] = String(r);
      grid.headers.forEach((header, i) => {
        const cell = getCell(sheet, r, i + 1);
        const where = `Playbook ${spec.sheet} row ${r} ${header}`;
        const value = cellText(cell, where, findings);
        const map = spec.columns[header];
        if (!map) return;
        if (!canonRow) {
          if (value !== null) {
            const column =
              map.kind === "playbook"
                ? map.column
                : map.kind === "canon"
                  ? map.column
                  : "normal_balance";
            intake.push(
              intakeRow(
                spec.sheet,
                r,
                header,
                { table: spec.table, key, column },
                value,
                null,
                `Row ${key} is in the Playbook ${spec.sheet} sheet but not in the Bible.`,
              ),
            );
          }
          return;
        }
        if (map.kind === "playbook") {
          canonRow[map.column] = value === null ? null : normalizeTyped(map.column, cell, value);
          return;
        }
        if (map.kind === "account-type-balance") {
          const type = String(canonRow["account_type"]);
          const set = balances.get(type) ?? new Set<string>();
          if (value !== null) set.add(value);
          balances.set(type, set);
          return;
        }
        const canonValue = map.read
          ? map.read(canonRow, ctx)
          : (canonRow[map.column] as string | null);
        if (!same(canonValue, value)) {
          intake.push(
            intakeRow(
              spec.sheet,
              r,
              header,
              { table: map.table, key, column: map.column },
              value,
              canonValue,
              `Playbook ${spec.sheet} differs from the Bible; neither silently wins.`,
            ),
          );
          diff.push({
            kind: "value",
            sheet: spec.sheet,
            row: r,
            column: header,
            key,
            bible: canonValue,
            playbook: value,
            note: `${map.table}.${map.column}`,
          });
        }
      });
      if (!canonRow) {
        diff.push({
          kind: "playbook-only-row",
          sheet: spec.sheet,
          row: r,
          column: spec.keyHeader,
          key,
          bible: null,
          playbook: keyValue,
          note: "Row is in the Playbook but not in the Bible; held in xpms.intake.",
        });
      }
    }
    for (const row of rows) {
      const key = String(row[spec.keyColumn]);
      if (!seen.has(key)) {
        diff.push({
          kind: "bible-only-row",
          sheet: spec.sheet,
          row: null,
          column: spec.keyHeader,
          key,
          bible: key,
          playbook: null,
          note: "Row is in the Bible but not in the Playbook sheet.",
        });
      }
    }
    tables.set(spec.table, rows);
  }
  const types = [...(tables.get("dim_gl_account_type") ?? [])].map((t) => ({ ...t }));
  for (const t of types) {
    const values = [...(balances.get(String(t["account_type"])) ?? [])];
    if (values.length === 1) t["normal_balance"] = values[0] ?? null;
    else if (values.length > 1) {
      findings.add(
        "conflict",
        "Playbook GL Accounts NORMAL BALANCE",
        `Account type ${String(t["account_type"])} carries several normal balances: ${values.join(", ")}.`,
      );
    }
  }
  tables.set("dim_gl_account_type", types);
}

/** A Playbook-only value in the storage form of its canon column. */
function normalizeTyped(column: string, cell: Cell, value: string): string {
  if (column.endsWith("_at")) {
    if (cell.kind !== "date" && cell.kind !== "datetime")
      throw new Error(`${column} expects a date-time, got ${cell.kind}`);
    return cell.text;
  }
  if (cell.kind === "number") return normalizeNumber(Number(cell.text));
  return value;
}

function typedStdValue(
  type: string | undefined,
  cell: Cell,
  where: string,
  findings: Findings,
): string | boolean | null {
  if (normalizeCell(cell) === "") return null;
  switch (type ?? "text") {
    case "bool":
      if (cell.kind !== "boolean")
        throw new Error(`${where}: expected TRUE or FALSE, got ${cell.kind}`);
      return cell.text === "TRUE";
    case "numeric":
    case "int":
      if (cell.kind !== "number")
        throw new Error(`${where}: expected a number, got ${cell.kind} "${cell.text}"`);
      return normalizeNumber(Number(cell.text));
    case "money":
      if (cell.kind !== "number") throw new Error(`${where}: expected an amount, got ${cell.kind}`);
      return toMinorUnits(normalizeNumber(Number(cell.text)));
    case "date":
      if (cell.kind !== "date") throw new Error(`${where}: expected a date, got ${cell.kind}`);
      return cell.text;
    case "timestamp":
      if (cell.kind !== "date" && cell.kind !== "datetime")
        throw new Error(`${where}: expected a date-time, got ${cell.kind}`);
      return cell.text;
    case "time":
      if (cell.kind !== "time") throw new Error(`${where}: expected a time, got ${cell.kind}`);
      return cell.text;
    default:
      return cellText(cell, where, findings);
  }
}

function buildStandardLibrary(
  playbook: WorkbookData,
  map: ColumnMap,
  tables: Map<string, SqlRow[]>,
  findings: Findings,
): void {
  for (const entry of map.sheets.filter((s) => s.destination === "standard-library")) {
    const spec = stdTableSpec(entry);
    const sheet = sheetByName(playbook, entry.sheet);
    const grid = sheetGrid(sheet);
    const hasMoney = entry.columns.some((c) => c.type === "money");
    const rows: SqlRow[] = grid.dataRows.map((r) => {
      const row: Record<string, string | boolean | null> = { source_row: String(r) };
      entry.columns.forEach((c, i) => {
        if (c.disposition !== "field") return;
        row[stdColumnName(c.key, c.type)] = typedStdValue(
          c.type,
          getCell(sheet, r, i + 1),
          `Playbook ${entry.sheet} row ${r} ${c.header}`,
          findings,
        );
      });
      if (hasMoney) row["currency_code"] = "USD";
      return row;
    });
    tables.set(spec.name, rows);
  }
}

function crossCheckLibrary(
  playbook: WorkbookData,
  tables: Map<string, SqlRow[]>,
  diff: DiffEntry[],
): void {
  const roles = new Set((tables.get("dim_role") ?? []).map((r) => r["role_code"]));
  for (const r of tables.get("std_role") ?? []) {
    const code = r["role_code"];
    if (!roles.has(code)) {
      diff.push({
        kind: "library-conflict",
        sheet: "Roles Library",
        row: Number(r["source_row"]),
        column: "ROLE CODE",
        key: String(code),
        bible: null,
        playbook: String(code),
        note: "Role code is not in Bible tab 27.",
      });
    }
  }
  const states = new Set([
    ...(tables.get("dim_state") ?? []).map((s) => String(s["state"])),
    ...(tables.get("dim_record_state") ?? []).map((s) => String(s["record_state"])),
  ]);
  const vocab: Readonly<Record<string, { name: string; values: Set<string> }>> = {
    "Workflow Status": { name: "Bible tabs 26 and 37 (states)", values: states },
    "Payment Status": { name: "Bible tabs 26 and 37 (states)", values: states },
    "Resource Kind": {
      name: "Item Catalog kind values",
      values: new Set((tables.get("elements") ?? []).map((e) => String(e["kind"]))),
    },
    "Unit of Measure": {
      name: "Item Catalog unit bases",
      values: new Set((tables.get("dim_unit_alias") ?? []).map((u) => String(u["alias"]))),
    },
  };
  for (const e of tables.get("std_enumeration") ?? []) {
    const domain = String(e["enum_domain"] ?? "");
    const label = String(e["enum_label"] ?? "");
    const v = vocab[domain];
    if (!v) continue;
    if (!v.values.has(label)) {
      diff.push({
        kind: "library-conflict",
        sheet: "Enumerations",
        row: Number(e["source_row"]),
        column: "ENUM LABEL",
        key: String(e["record_id"] ?? ""),
        bible: null,
        playbook: `${domain}: ${label}`,
        note: `Label is not in ${v.name}.`,
      });
    }
  }
  void playbook;
}

function buildTemplate(
  playbook: WorkbookData,
  map: ColumnMap,
  tables: Map<string, SqlRow[]>,
  findings: Findings,
  sha: string,
): RealWorldRow[] {
  tables.set("production_template", [
    {
      template_code: TEMPLATE_CODE,
      name: "XOS 4.0 Production Template",
      source_file: PLAYBOOK_FILE,
      source_sha256: sha,
      is_published: false,
    },
  ]);
  const cover = sheetByName(playbook, COVER_SHEET);
  const meta: SqlRow[] = [];
  for (const [r, cols] of cover.rows) {
    for (const [c, cell] of cols) {
      if (cell.formula === undefined && normalizeCell(cell) === "") continue;
      meta.push({
        template_code: TEMPLATE_CODE,
        source_row: String(r),
        column_ordinal: String(c),
        value_text: cellText(cell, `Playbook Cover Page ${columnLetter(c)}${r}`, findings),
        value_kind: cell.kind,
        formula: cell.formula ?? null,
      });
    }
  }
  tables.set("production_template_metadata", meta);
  const rows: SqlRow[] = [];
  const values: SqlRow[] = [];
  const realWorld: RealWorldRow[] = [];
  for (const entry of map.sheets.filter((s) => s.destination === "production-template")) {
    const sheet: SheetData = sheetByName(playbook, entry.sheet);
    const grid = sheetGrid(sheet);
    for (const r of grid.dataRows) {
      rows.push({ template_code: TEMPLATE_CODE, sheet_name: entry.sheet, source_row: String(r) });
      const flagged: string[] = [];
      entry.columns.forEach((c, i) => {
        const cell = getCell(sheet, r, i + 1);
        if (c.disposition !== "field" || normalizeCell(cell) === "") return;
        if (cell.kind === "empty" || cell.kind === "error")
          throw new Error(`${entry.sheet} ${c.letter}${r} holds ${cell.kind}`);
        values.push({
          template_code: TEMPLATE_CODE,
          sheet_name: entry.sheet,
          source_row: String(r),
          column_ordinal: String(i + 1),
          value_text: cellText(cell, `Playbook ${entry.sheet} ${c.letter}${r}`, findings) ?? "",
          value_kind: cell.kind,
        });
        if (c.real_world) flagged.push(`${c.header} (${c.real_world})`);
      });
      if (flagged.length > 0) {
        realWorld.push({
          sheet: entry.sheet,
          row: r,
          id: normalizeCell(getCell(sheet, r, 1)),
          columns: flagged,
        });
      }
    }
  }
  tables.set("production_template_rows", rows);
  tables.set("production_template_values", values);
  return realWorld;
}

function registry(playbook: WorkbookData, map: ColumnMap, tables: Map<string, SqlRow[]>): void {
  tables.set(
    "playbook_sheet",
    playbook.sheets.map((s) => {
      const entry = entryFor(map, s.name);
      const grid = sheetGrid(s);
      return {
        sheet_name: s.name,
        sheet_key: entry.key,
        ordinal: String(s.index),
        destination: entry.destination,
        entity: entry.entity,
        header_row: grid.headerRow === null ? null : String(grid.headerRow),
        used_range: s.usedRange === "" ? null : s.usedRange,
        data_row_count: String(grid.dataRows.length),
        checksum_sha256: sheetChecksum(s, grid),
      };
    }),
  );
  tables.set(
    "playbook_column",
    map.sheets.flatMap((s) =>
      s.columns.map((c, i) => ({
        sheet_name: s.sheet,
        ordinal: String(i + 1),
        letter: c.letter,
        header: c.header === "" ? null : c.header,
        column_key: c.key,
        disposition: c.disposition,
        target: c.target ?? null,
        data_type: c.type ?? null,
        note:
          c.disposition === "presentation"
            ? (c.reason ?? null)
            : (c.transform ?? c.formula ?? null),
      })),
    ),
  );
}

export function applyPlaybook(
  canon: ReadonlyMap<string, readonly SqlRow[]>,
  canonIntake: readonly IntakeRow[],
  playbook: WorkbookData,
  map: ColumnMap,
  findings: Findings,
  sha: string,
): PlaybookResult {
  const tables = new Map<string, SqlRow[]>();
  for (const [k, v] of canon) tables.set(k, [...v]);
  const intake = [...canonIntake];
  const diff: DiffEntry[] = [];
  applyMirrors(playbook, tables, intake, diff, findings);
  buildStandardLibrary(playbook, map, tables, findings);
  crossCheckLibrary(playbook, tables, diff);
  registry(playbook, map, tables);
  const realWorld = buildTemplate(playbook, map, tables, findings, sha);
  return { tables, intake, diff, realWorld };
}
