import { parse, stringify } from "yaml";
import { columnLetter } from "../cell.ts";
import type { CellKind } from "../cell.ts";
import { normalizeCell } from "../normalize.ts";
import { getCell } from "../workbook.ts";
import type { SheetData, WorkbookData } from "../workbook.ts";
import { sheetGrid } from "../manifest.ts";
import { COVER_SHEET, destinationOf, sheetKey } from "./layout.ts";
import type { Destination } from "./layout.ts";

/**
 * The Playbook column map (canon/map/playbook-columns.yaml, Section 2.1). Every
 * column of every sheet carries exactly one disposition:
 * - field: the target schema.table.column, its data type and transform;
 * - computed: the SQL that reproduces a formula column, verified on every row
 *   by the round-trip proof;
 * - presentation: layout only, with a one-line reason.
 * The importer writes a skeleton for new columns and keeps every completed entry.
 */

export type Disposition = "field" | "computed" | "presentation";

export type FieldType =
  "text" | "code" | "numeric" | "int" | "bool" | "date" | "timestamp" | "time" | "money";

export interface ColumnEntry {
  letter: string;
  header: string;
  key: string;
  disposition: Disposition;
  /** schema.table.column the value lands in (field), or the computed column it feeds. */
  target?: string;
  type?: FieldType;
  transform?: string;
  /** Source formula of a computed column, as the first data row holds it. */
  formula?: string;
  /** SQL expression reproducing the column in the export view. */
  sql?: string;
  reason?: string;
  /** Classification of real-world data the column can hold (person, company, contact, venue, price, identifier). */
  real_world?: string;
}

export interface SheetEntry {
  sheet: string;
  key: string;
  destination: Destination;
  /** Target entity: an xpms table, or the app table a later wave creates. */
  entity: string;
  /** Agent and wave that own the target entity when it is not in xpms. */
  depends_on?: string;
  /** For canon mirrors: the export query returning (source_row, cells) from canon and intake. */
  query?: string;
  columns: ColumnEntry[];
}

export interface ColumnMap {
  version: number;
  sheets: SheetEntry[];
}

/** Target app entities of the Production Template sheets (Section 7.4 names; A03 and later waves create them). */
export const TEMPLATE_ENTITIES: Readonly<Record<string, string>> = {
  "Access Grid": "app.access_grid",
  "Activity Log": "app.activity_events",
  "Advance Requests": "app.advance_submissions",
  "Asset Assignments": "app.asset_custody",
  "Asset Inventory": "app.asset_units",
  "Budget Expenses": "app.budget_lines",
  "Change Orders": "app.change_orders",
  "Credential Issuance": "app.credentials",
  "Crew Shifts": "app.shifts",
  "Crew Timesheets": "app.timesheets",
  "Hospitality Fulfillment": "app.fulfillments",
  "Incident CAD Log": "app.incidents",
  "Inspection Compliance": "app.inspections",
  Locations: "app.spaces",
  "Marshalling Yard Log": "app.marshalling_log",
  "Personnel Roster": "app.role_assignments",
  "PO Line Items": "app.po_lines",
  "Production Schedule": "app.records",
  "Production Tasks": "app.records",
  Projects: "app.projects",
  "Purchase Orders": "app.purchase_orders",
  "Run of Show": "app.cues",
  "Shipping Manifest": "app.shipments",
  "Staffing Requisition": "app.requisitions",
  "Universal Posting Line": "app.posting_lines",
  "Vendor Directory": "app.vendors",
  "Work Orders": "app.records",
};

/** Standard Library tables (Section 7.2). */
export const STD_TABLES: Readonly<Record<string, string>> = {
  "Document & Asset Library": "std_document_library",
  Enumerations: "std_enumeration",
  "Radio Channels": "std_radio_channel",
  "SOP Library": "std_sop",
  "Vendor Classes": "std_vendor_class",
  "Vendor Entitlements": "std_vendor_entitlement",
  "Verbiage Library": "std_verbiage",
};

/**
 * Standard Library sheets the owner's reference model normalizes (decisions D12
 * to D16): they land in reference tables rather than a std_* copy of the sheet.
 */
export const REFERENCE_SHEETS: Readonly<Record<string, string>> = {
  "Emergency Codes": "emergency_protocol",
  "Labor Rate Cards": "rate_card",
  "Roles Library": "role",
};

export function columnKey(header: string, letter: string, taken: ReadonlySet<string>): string {
  const base =
    header
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/%/g, " pct ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || `column_${letter.toLowerCase()}`;
  const safe = /^[0-9]/.test(base) ? `c_${base}` : base;
  return taken.has(safe) ? `${safe}_${letter.toLowerCase()}` : safe;
}

/** Data type implied by the non-empty cells of a column. */
export function inferType(kinds: ReadonlySet<CellKind>): FieldType {
  const k = [...kinds].filter((x) => x !== "empty");
  if (k.length === 0) return "text";
  if (k.every((x) => x === "number")) return "numeric";
  if (k.every((x) => x === "boolean")) return "bool";
  if (k.every((x) => x === "date")) return "date";
  if (k.every((x) => x === "date" || x === "datetime")) return "timestamp";
  if (k.every((x) => x === "time")) return "time";
  return "text";
}

interface ColumnFacts {
  readonly kinds: Set<CellKind>;
  readonly formulaRows: number;
  readonly literalRows: number;
  readonly firstFormula?: string;
}

function columnFacts(sheet: SheetData, column: number, rows: readonly number[]): ColumnFacts {
  const kinds = new Set<CellKind>();
  let formulaRows = 0;
  let literalRows = 0;
  let firstFormula: string | undefined;
  for (const r of rows) {
    const cell = getCell(sheet, r, column);
    kinds.add(cell.kind);
    if (cell.formula !== undefined) {
      formulaRows += 1;
      firstFormula ??= cell.formula;
    } else if (normalizeCell(cell) !== "") literalRows += 1;
  }
  return firstFormula === undefined
    ? { kinds, formulaRows, literalRows }
    : { kinds, formulaRows, literalRows, firstFormula };
}

function entityOf(sheet: string, destination: Destination): string {
  switch (destination) {
    case "standard-library":
      return `xpms.${STD_TABLES[sheet] ?? REFERENCE_SHEETS[sheet] ?? sheetKey(sheet)}`;
    case "production-template":
      return TEMPLATE_ENTITIES[sheet] ?? `app.${sheetKey(sheet)}`;
    case "template-metadata":
      return "xpms.production_template_metadata";
    case "canon-mirror":
      return "xpms";
  }
}

/** Skeleton entry for one sheet, inferred from the workbook. */
export function skeletonSheet(sheet: SheetData): SheetEntry {
  const destination = destinationOf(sheet.name);
  const grid = sheetGrid(sheet);
  const entity = entityOf(sheet.name, destination);
  const taken = new Set<string>();
  const columns: ColumnEntry[] = grid.headers.map((header, i) => {
    const letter = columnLetter(i + 1);
    const key =
      sheet.name === COVER_SHEET ? letter.toLowerCase() : columnKey(header, letter, taken);
    taken.add(key);
    const facts = columnFacts(sheet, i + 1, grid.dataRows);
    const type = inferType(facts.kinds);
    if (sheet.name === COVER_SHEET) {
      return {
        letter,
        header,
        key,
        disposition: "field",
        target: "xpms.production_template_metadata.value_text",
        type: "text",
        transform:
          "Cover cell stored at its row and column; a formula cell keeps its evaluated value and its formula text as template metadata.",
      };
    }
    if (facts.formulaRows > 0 && destination !== "canon-mirror") {
      return {
        letter,
        header,
        key,
        disposition: "computed",
        target: `${entity}.${key}`,
        type,
        ...(facts.firstFormula === undefined ? {} : { formula: facts.firstFormula }),
      };
    }
    return { letter, header, key, disposition: "field", target: `${entity}.${key}`, type };
  });
  return {
    sheet: sheet.name,
    key: sheetKey(sheet.name),
    destination,
    entity,
    ...(destination === "production-template" ? { depends_on: "A03 Domain Data (Wave 2)" } : {}),
    columns,
  };
}

/**
 * Merges a completed map with a fresh skeleton: every completed column entry is
 * kept as written; new sheets and columns get skeleton entries; a header that
 * changed in the workbook stops the import so a stale mapping is never reused.
 */
export function mergeColumnMap(existing: ColumnMap | null, workbook: WorkbookData): ColumnMap {
  const sheets = workbook.sheets.map((s) => {
    const fresh = skeletonSheet(s);
    const done = existing?.sheets.find((e) => e.sheet === s.name);
    if (!done) return fresh;
    const columns = fresh.columns.map((c) => {
      const kept = done.columns.find((d) => d.letter === c.letter);
      if (!kept) return c;
      if (kept.header !== c.header) {
        throw new Error(
          `${s.name} column ${c.letter} header changed from "${kept.header}" to "${c.header}"; remap it`,
        );
      }
      return kept;
    });
    return { ...fresh, ...done, columns };
  });
  return { version: 1, sheets };
}

export function readColumnMap(text: string): ColumnMap {
  const doc = parse(text) as ColumnMap;
  if (!doc || !Array.isArray(doc.sheets)) throw new Error("Column map has no sheets list");
  return doc;
}

export function writeColumnMap(map: ColumnMap): string {
  const header =
    "# Playbook column map (Section 2.1). Generated by @xos/canon-import, completed by A01.\n" +
    "# Every column of every sheet has exactly one disposition: field, computed or presentation.\n" +
    "# The importer keeps completed entries on re-run and adds skeleton entries for new columns.\n";
  return header + stringify(map, { lineWidth: 0 });
}

const DISPOSITIONS: readonly Disposition[] = ["field", "computed", "presentation"];

/** Problems that keep the map from being complete. */
export function validateColumnMap(map: ColumnMap, workbook: WorkbookData): string[] {
  const problems: string[] = [];
  for (const s of workbook.sheets) {
    const entry = map.sheets.find((e) => e.sheet === s.name);
    if (!entry) {
      problems.push(`Sheet ${s.name} is not in the column map`);
      continue;
    }
    const grid = sheetGrid(s);
    if (entry.columns.length !== grid.headers.length) {
      problems.push(
        `${s.name}: map has ${entry.columns.length} columns, the sheet has ${grid.headers.length}`,
      );
    }
    const keys = new Set<string>();
    entry.columns.forEach((c, i) => {
      const where = `${s.name} ${c.letter}`;
      if (c.letter !== columnLetter(i + 1)) problems.push(`${where}: out of order`);
      if (c.header !== (grid.headers[i] ?? ""))
        problems.push(`${where}: header "${c.header}" differs from the sheet`);
      if (keys.has(c.key)) problems.push(`${where}: key ${c.key} repeats`);
      keys.add(c.key);
      if (!DISPOSITIONS.includes(c.disposition))
        problems.push(`${where}: unknown disposition ${String(c.disposition)}`);
      if (c.disposition === "field" && !c.target) problems.push(`${where}: field has no target`);
      if (c.disposition === "field" && !c.type) problems.push(`${where}: field has no type`);
      if (c.disposition === "computed" && !c.sql)
        problems.push(`${where}: computed column has no SQL`);
      if (c.disposition === "presentation" && !c.reason)
        problems.push(`${where}: presentation column has no reason`);
    });
    if (entry.destination === "canon-mirror" && !entry.query) {
      problems.push(`${s.name}: canon mirror needs its export query`);
    }
  }
  return problems;
}

export interface DispositionTotals {
  readonly field: number;
  readonly computed: number;
  readonly presentation: number;
}

export function dispositionTotals(map: ColumnMap): DispositionTotals {
  const totals = { field: 0, computed: 0, presentation: 0 };
  for (const s of map.sheets) for (const c of s.columns) totals[c.disposition] += 1;
  return totals;
}
