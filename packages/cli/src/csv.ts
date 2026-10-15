/** RFC 4180 CSV, plus NDJSON and JSON array readers, for import and export. */

export type Row = Record<string, unknown>;

export function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error("The CSV ends inside a quoted field.");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header, ...rows] = records.filter((r) => !(r.length === 1 && r[0] === ""));
  if (!header) return [];
  return rows.map((r, index) => {
    if (r.length !== header.length) {
      throw new Error(
        `CSV row ${index + 2} has ${r.length} fields; the header has ${header.length}.`,
      );
    }
    // An empty cell is null: unknown, never zero (Section 3.11).
    return Object.fromEntries(header.map((h, i) => [h, r[i] === "" ? null : r[i]]));
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function formatCsv(rows: readonly Row[], columns?: readonly string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [
    cols.map(csvCell).join(","),
    ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

/** Reads rows from CSV, NDJSON or a JSON array, chosen by file extension. */
export function parseRows(text: string, fileName: string): Row[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return parseCsv(text);
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) {
    return text
      .split(/\r?\n/)
      .map((line, i) => [line, i] as const)
      .filter(([line]) => line.trim() !== "")
      .map(([line, i]) => {
        const value = JSON.parse(line) as unknown;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error(`Line ${i + 1} is not a JSON object.`);
        }
        return value as Row;
      });
  }
  if (lower.endsWith(".json")) {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value))
      throw new Error("A .json import file must hold an array of objects.");
    return value as Row[];
  }
  throw new Error(`Use a .csv, .ndjson, .jsonl or .json file; got ${fileName}.`);
}
