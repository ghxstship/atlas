/**
 * Spreadsheet reading and column suggestions for the import worker (A36, Section 4.6.2 steps 2 and 3).
 * Pure functions: a CSV reader (RFC 4180, quoted fields, CRLF or LF), header row detection and a
 * header-to-field suggestion from header similarity. The .xlsx reader lives in import-worker.ts so
 * its library loads only in the worker.
 * P3 (RRR-217) adds pasted rows (tab- or comma-separated, read in the browser for the live preview and
 * written back as CSV for upload) and the cell readers of a rundown: cue numbers, times on the show date
 * and durations. The import page loads this module; the shell and the show pages never do.
 */

export interface Sheet {
  readonly name: string;
  /** Every row as cell text, in spreadsheet order. Row 1 is the first line. */
  readonly rows: readonly (readonly string[])[];
}

/** Reads CSV text into rows of cells; a leading byte order mark is dropped. */
export function parseCsv(text: string): string[][] {
  return parseDelimited(text, ",");
}

/**
 * Reads delimited text into rows of cells (RFC 4180 with any one-character delimiter): quoted cells may hold the
 * delimiter, doubled quotes and line breaks. A leading byte order mark is dropped.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
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
    } else if (ch === delimiter) {
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

/**
 * Reads rows pasted from Excel, Google Sheets or a rundown tool: tab-separated when the first line with text has a
 * tab (what spreadsheets put on the clipboard), otherwise CSV.
 */
export function parsePasted(text: string): string[][] {
  const first = text.split(/\r\n|\n|\r/).find((line) => line.trim() !== "") ?? "";
  return parseDelimited(text, first.includes("\t") ? "\t" : ",");
}

/** Writes rows as CSV (RFC 4180): a cell with a comma, a quote or a line break is quoted, quotes doubled. */
export function rowsToCsv(rows: readonly (readonly string[])[]): string {
  const cell = (c: string) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

// Rundown cells (P3) ---------------------------------------------------------------------------------------------

/** A cue number as a positive whole number: '12', 'Q12', 'CUE-07' or 'Cue 7'. Null for '12.5', 0 or anything else. */
export function cuePosition(text: string): number | null {
  const m = /^(?:(?:q|cue)[\s#-]*|#\s*)?(\d{1,9})$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/** Offset of an IANA zone from UTC at an instant, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) -
    instant
  );
}

const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A planned time as an ISO instant: 'HH:MM[:SS]' or 'h:mm AM/PM' on the running order's show date (YYYY-MM-DD) in
 * the project's time zone, or an ISO 8601 date and time with an offset as written. Null when the text is none of
 * these. A wall-clock time that a clock change skips lands an hour later, as the zone reads it.
 */
export function plannedAt(text: string, showDate: string, timeZone: string): string | null {
  const v = text.trim();
  if (ISO_WITH_OFFSET.test(v)) {
    const at = Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(showDate);
  if (!date) return null;
  let hour: number;
  let minute: number;
  let second: number;
  const h24 = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  const h12 = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i.exec(v);
  if (h24) {
    [hour, minute, second] = [Number(h24[1]), Number(h24[2]), Number(h24[3] ?? 0)];
    if (hour > 23) return null;
  } else if (h12) {
    [hour, minute, second] = [Number(h12[1]), Number(h12[2] ?? 0), Number(h12[3] ?? 0)];
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (h12[4]?.toLowerCase() === "p" ? 12 : 0);
  } else {
    return null;
  }
  if (minute > 59 || second > 59) return null;
  const [y, mo, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
  const wall = Date.UTC(y, mo - 1, d, hour, minute, second);
  if (new Date(wall).getUTCDate() !== d) return null;
  try {
    let instant = wall - zoneOffset(wall, timeZone);
    instant = wall - zoneOffset(instant, timeZone);
    return new Date(instant).toISOString();
  } catch (error) {
    if (error instanceof RangeError) return null; // Not an IANA zone.
    throw error;
  }
}

/** The largest cue duration, one day, as Atlas's cue form allows. */
export const MAX_CUE_DURATION_SECONDS = 86_400;

/** A duration in seconds from minutes ('90', '2.5'), 'm:ss' or 'h:mm:ss'; null outside 0 to one day or unreadable. */
export function durationSeconds(text: string): number | null {
  const v = text.trim();
  let seconds: number;
  if (/^\d+(?:\.\d+)?$/.test(v)) {
    seconds = Math.round(Number(v) * 60);
  } else {
    const m = /^(?:(\d+):)?(\d{1,3}):(\d{2})$/.exec(v);
    if (!m || Number(m[3]) > 59 || (m[1] !== undefined && Number(m[2]) > 59)) return null;
    seconds = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return seconds <= MAX_CUE_DURATION_SECONDS ? seconds : null;
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
  // Rundowns (P3). A header that is only '#' means the cue number; normalize() drops it, so similarField checks it.
  position: ["cue", "cueno", "cuenumber", "cueid", "number", "no"],
  label: ["scene", "title", "cuename", "item"],
  segment: ["act", "section", "segment", "block"],
  planned_at: ["time", "start", "starttime", "at"],
  duration: ["length", "duration", "mins", "durationmin", "runtime"],
  space_id: ["location", "space", "room", "stage"],
  // Guest lists (P3).
  guest_name: ["guest", "name", "fullname", "guestname", "attendee"],
  plus_ones: ["plus", "plusones", "plus1", "extra"],
  note: ["notes", "comment", "access"],
  scope_node_id: ["show", "night", "scope"],
  counterparty_id: ["list", "company", "onlistof", "sponsor", "client"],
};

/** The target field a header names by its own name or a synonym; a header of only '#' is the cue number. */
function similarField(header: string, fields: readonly string[]): string | undefined {
  const n = normalize(header);
  if (header.trim() === "#") return fields.includes("position") ? "position" : undefined;
  return (
    fields.find((f) => normalize(f) === n) ??
    fields.find((f) => (FIELD_SYNONYMS[f] ?? []).includes(n))
  );
}

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
    const pick =
      (fromProfile && fields.includes(fromProfile) ? fromProfile : undefined) ??
      similarField(header, fields);
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
  cues: "app.cues",
  guest_list_entries: "app.guest_list_entries",
};

/** Playbook targets that land in an import field of another table: a counterparty's name is its organization's. */
const PLAYBOOK_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  counterparties: { "app.organizations.name": "name" },
};

/**
 * Playbook entities whose sheet is imported into a target: Asset Inventory into asset units, Vendor Directory into
 * counterparties, Run of Show into cues (S4.6.2-02).
 */
const PLAYBOOK_ENTITY_TARGETS: Readonly<Record<string, string>> = {
  "app.asset_units": "asset_units",
  "app.vendors": "counterparties",
  "app.counterparties": "counterparties",
  "app.venues": "venues",
  "app.vendor_products": "vendor_products",
  "app.cues": "cues",
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

export type SuggestionSource = "Profile" | "Playbook" | "Header";

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
    const similar = similarField(header, fields);
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
