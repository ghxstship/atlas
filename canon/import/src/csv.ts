/**
 * RFC 4180 CSV reader for the canon CSV files. A leading byte order mark is
 * dropped, quoted fields may hold commas, quotes and line breaks, and every
 * record must have as many fields as the header.
 */

export interface CsvTable {
  readonly headers: readonly string[];
  /** One record per data line, keyed by header, with its 1-based line number. */
  readonly records: readonly {
    readonly line: number;
    readonly values: Readonly<Record<string, string>>;
  }[];
}

export function parseCsvRows(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0)
        throw new Error(`Stray quote inside an unquoted field on row ${rows.length + 1}`);
      quoted = true;
      i += 1;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && source[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (quoted) throw new Error("Unterminated quoted field at end of file");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCsv(text: string): CsvTable {
  const rows = parseCsvRows(text);
  const [headers, ...data] = rows;
  if (!headers || headers.length === 0) throw new Error("CSV has no header row");
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h)) throw new Error(`CSV header "${h}" appears twice`);
    seen.add(h);
  }
  const records = data.map((cells, i) => {
    if (cells.length !== headers.length) {
      throw new Error(
        `CSV line ${i + 2} has ${cells.length} fields; the header has ${headers.length}`,
      );
    }
    const values: Record<string, string> = {};
    headers.forEach((h, j) => {
      values[h] = cells[j] ?? "";
    });
    return { line: i + 2, values };
  });
  return { headers, records };
}
