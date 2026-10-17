/**
 * Spreadsheet reading and column suggestions for the import worker (A36, Section 4.6.2 steps 2 and 3).
 * Pure functions: a CSV reader (RFC 4180, quoted fields, CRLF or LF), header row detection and a
 * header-to-field suggestion from header similarity. The .xlsx reader lives in import-worker.ts so
 * its library loads only in the worker.
 */

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
