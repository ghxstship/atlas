/**
 * Spreadsheet reading and column suggestions for the import worker (A36, Section 4.6.2 steps 2 and 3).
 * Pure functions: a CSV reader (RFC 4180, quoted fields, CRLF or LF), header row detection and a
 * header-to-field suggestion from header similarity. The .xlsx reader lives in import-worker.ts so
 * its library loads only in the worker.
 */

import type { Database } from "./database.types.ts";
export interface Sheet {
  readonly name: string;
  /** Every row as cell text, in spreadsheet order. Row 1 is the first line. */
  readonly rows: readonly (readonly string[])[];
}

/** Reads CSV text into rows of cells; a leading byte order mark is dropped. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const isBlank = (row: readonly string[]) => row.every((c) => c.trim() === "");

/** The header row: the first row with any text. Its one-based row number, or null for an empty sheet. */
export function headerRowNumber(sheet: Sheet): number | null {
  const index = sheet.rows.findIndex((r) => !isBlank(r));
  return index < 0 ? null : index + 1;
}

export interface DataRow {
  /** One-based row number as the person sees it in the spreadsheet. */
  readonly rowNumber: number;
  readonly cells: readonly string[];
}

/** Rows below the header row, skipping blank rows. */
export function dataRows(sheet: Sheet): DataRow[] {
  const header = headerRowNumber(sheet);
  if (header === null) return [];
  const out: DataRow[] = [];
  for (let i = header; i < sheet.rows.length; i += 1) {
    const cells = sheet.rows[i] ?? [];
    if (!isBlank(cells)) out.push({ rowNumber: i + 1, cells: cells.map((c) => c.trim()) });
  }
  return out;
}

export function headers(sheet: Sheet): string[] {
  const header = headerRowNumber(sheet);
  return header === null ? [] : (sheet.rows[header - 1] ?? []).map((h) => h.trim());
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Other header words that mean a field, beyond the field's own name (header similarity, step 3). */
export const FIELD_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  name: [
    "company",
    "companyname",
    "customer",
    "customername",
    "organization",
    "organisation",
    "client",
    "venue",
    "venuename",
    "account",
  ],
  street_address: ["address", "street", "streetaddress", "address1", "addressline1"],
  locality: ["city", "town", "locality"],
  postal_code: ["zip", "zipcode", "postcode", "postalcode"],
  jurisdiction_id: ["jurisdiction", "jurisdictioncode"],
  time_zone: ["timezone", "tz", "zone"],
  counterparty_type: ["type", "category", "vendortype", "counterpartytype"],
  vendor_sku: ["sku", "partnumber", "itemnumber", "vendorsku"],
  vendor_name: ["vendor", "supplier", "vendorname"],
  element_id: ["element", "elementid", "item", "itemid"],
  unit_price_minor: ["unitprice", "price", "unitpricecents", "pricecents"],
  currency_code: ["currency", "currencycode"],
  lead_time_days: ["leadtime", "leadtimedays", "lead"],
  asset_tag: ["tag", "assettag", "barcode"],
  asset_class_id: ["assetclass", "class", "category"],
  home_venue_id: ["homevenue", "venue", "location"],
};

/**
 * Suggests a field for each header: a saved profile's mapping first, then an exact field name, then a
 * synonym. Each field is suggested once, for its first matching header; the person confirms every one.
 */
export function suggestMapping(
  headerTexts: readonly string[],
  fields: readonly string[],
  profile: ReadonlyMap<string, string> = new Map(),
): (string | null)[] {
  const used = new Set<string>();
  return headerTexts.map((header) => {
    const fromProfile = profile.get(header.toLowerCase());
    const n = normalize(header);
    const pick =
      (fromProfile && fields.includes(fromProfile) ? fromProfile : undefined) ??
      fields.find((f) => normalize(f) === n) ??
      fields.find((f) => (FIELD_SYNONYMS[f] ?? []).includes(n));
    if (!pick || used.has(pick)) return null;
    used.add(pick);
    return pick;
  });
}

// Sheets, the Playbook column map and target proposals (A83, finding A65-025) --------------------------------------

export interface SheetLayout {
  /** One-based header row, or null for an empty sheet. */
  readonly headerRow: number | null;
  readonly firstDataRow: number | null;
  /** One-based last row with any text; 0 for an empty sheet. */
  readonly lastRow: number;
  readonly columnCount: number;
  readonly dataRowCount: number;
}

/** Header row, data range and size of a sheet (Section 4.6.2 step 2). */
export function sheetLayout(sheet: Sheet): SheetLayout {
  const rows = dataRows(sheet);
  let last = 0;
  sheet.rows.forEach((r, i) => {
    if (!isBlank(r)) last = i + 1;
  });
  return {
    headerRow: headerRowNumber(sheet),
    firstDataRow: rows[0]?.rowNumber ?? null,
    lastRow: last,
    columnCount: headers(sheet).length,
    dataRowCount: rows.length,
  };
}

/** One column of the Playbook column map (xpms.playbook_column, canon/map/playbook-columns.yaml). */
export interface PlaybookColumn {
  readonly sheet: string;
  readonly header: string;
  /** schema.table.column the column lands in. */
  readonly target: string;
}

/** A Playbook sheet and the entity it fills (xpms.playbook_sheet). */
export interface PlaybookSheet {
  readonly sheet: string;
  readonly entity: string;
}

/** The table each import target writes, as the Playbook map names tables. */
export const IMPORT_TARGET_TABLES: Readonly<Record<string, string>> = {
  venues: "app.venues",
  counterparties: "app.counterparties",
  vendor_products: "app.vendor_products",
  asset_units: "app.asset_units",
};

/** Playbook targets that land in an import field of another table: a counterparty's name is its organization's. */
const PLAYBOOK_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  counterparties: { "app.organizations.name": "name" },
};

/** Playbook entities whose sheet is imported into a target: Asset Inventory into asset units, Vendor Directory into counterparties. */
const PLAYBOOK_ENTITY_TARGETS: Readonly<Record<string, string>> = {
  "app.asset_units": "asset_units",
  "app.vendors": "counterparties",
  "app.counterparties": "counterparties",
  "app.venues": "venues",
  "app.vendor_products": "vendor_products",
};

/**
 * Header-to-field pairs the Playbook column map gives one target: a Playbook column whose target is a field of
 * the target's table (or an alias of one). A header the map sends to two different fields is left out, so the
 * map never guesses.
 */
export function playbookFieldMap(
  columns: readonly PlaybookColumn[],
  targetCode: string,
  fields: readonly string[],
): ReadonlyMap<string, string> {
  const table = IMPORT_TARGET_TABLES[targetCode];
  const aliases = PLAYBOOK_ALIASES[targetCode] ?? {};
  const found = new Map<string, Set<string>>();
  for (const c of columns) {
    const field =
      aliases[c.target] ??
      (table !== undefined && c.target.startsWith(`${table}.`)
        ? c.target.slice(table.length + 1)
        : undefined);
    if (field === undefined || !fields.includes(field) || c.header.trim() === "") continue;
    const key = normalize(c.header);
    found.set(key, (found.get(key) ?? new Set<string>()).add(field));
  }
  const map = new Map<string, string>();
  for (const [header, set] of found) {
    const [only] = [...set];
    if (set.size === 1 && only !== undefined) map.set(header, only);
  }
  return map;
}

export type SuggestionSource = Database["app"]["Enums"]["import_suggestion_source"];

export interface Suggestion {
  readonly field: string | null;
  readonly source: SuggestionSource | null;
}

/**
 * Suggests a field for each header and says where it came from (Section 4.6.2 step 3): a saved profile first,
 * then the Playbook column map, then header similarity (the field's own name, then a synonym). Each field is
 * suggested once; the person confirms every one. The assistant's suggestions come later, in the wizard.
 */
export function suggestWithSources(
  headerTexts: readonly string[],
  fields: readonly string[],
  profile: ReadonlyMap<string, string> = new Map(),
  playbook: ReadonlyMap<string, string> = new Map(),
): Suggestion[] {
  const used = new Set<string>();
  return headerTexts.map((header) => {
    const n = normalize(header);
    const fromProfile = profile.get(header.toLowerCase());
    const similar =
      fields.find((f) => normalize(f) === n) ??
      fields.find((f) => (FIELD_SYNONYMS[f] ?? []).includes(n));
    const candidates: [string | undefined, SuggestionSource][] = [
      [fromProfile && fields.includes(fromProfile) ? fromProfile : undefined, "Profile"],
      [playbook.get(n), "Playbook"],
      [similar, "Header"],
    ];
    const hit = candidates.find(([field]) => field !== undefined && !used.has(field));
    if (hit?.[0] === undefined) return { field: null, source: null };
    used.add(hit[0]);
    return { field: hit[0], source: hit[1] };
  });
}

export interface TargetProposal {
  readonly targetCode: string | null;
  readonly fromPlaybook: boolean;
}

export interface ProposalTarget {
  readonly code: string;
  readonly fields: readonly string[];
  readonly required: readonly string[];
}

/**
 * The target proposed for a sheet (Section 4.6.2 step 2): the target of the Playbook sheet of the same name when
 * there is one, otherwise the target whose fields the headers match best, provided at least two headers match
 * or every required field does. Null when nothing fits; the person chooses.
 */
export function proposeTarget(
  sheet: Sheet,
  targets: readonly ProposalTarget[],
  playbookSheets: readonly PlaybookSheet[],
  playbookColumns: readonly PlaybookColumn[],
): TargetProposal {
  const named = playbookSheets.find((p) => normalize(p.sheet) === normalize(sheet.name));
  const fromPlaybook = named ? PLAYBOOK_ENTITY_TARGETS[named.entity] : undefined;
  if (fromPlaybook !== undefined && targets.some((t) => t.code === fromPlaybook)) {
    return { targetCode: fromPlaybook, fromPlaybook: true };
  }
  const heads = headers(sheet);
  let best: { code: string; score: number } | null = null;
  for (const t of targets) {
    const playbook = playbookFieldMap(playbookColumns, t.code, t.fields);
    const matched = suggestWithSources(heads, t.fields, new Map(), playbook)
      .map((s) => s.field)
      .filter((f): f is string => f !== null);
    const allRequired = t.required.length > 0 && t.required.every((r) => matched.includes(r));
    const score = matched.length + (allRequired ? 1 : 0);
    if ((matched.length >= 2 || allRequired) && (best === null || score > best.score)) {
      best = { code: t.code, score };
    }
  }
  return { targetCode: best?.code ?? null, fromPlaybook: false };
}
