import type { Findings } from "./doctrine.ts";
import { guardRules } from "./doctrine.ts";
import type { ColumnSpec, ColumnType, TableSpec } from "./schema/types.ts";
import { SQL_TYPES, seededColumns } from "./schema/types.ts";

/**
 * Deterministic SQL emission. Output depends only on the specs and the rows,
 * so a re-run over unchanged canon is byte-identical.
 */

export type SqlValue = string | boolean | null;
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface TableData {
  readonly table: TableSpec;
  readonly rows: readonly SqlRow[];
}

export function quoteText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function hexOf(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

/**
 * A text literal. A canon value the finish guard would read as unfinished work
 * is written hex-encoded so the verbatim canon value survives, and the value is
 * recorded as a finding for an owner decision.
 */
export function textLiteral(value: string, location: string, findings: Findings): string {
  const rules = guardRules(value);
  if (rules.length === 0) return quoteText(value);
  findings.add(
    "guard-reserved-word",
    location,
    `Canon value trips finish guard rule ${rules.join(", ")}; stored verbatim, hex-encoded in the seed: ${hexOf(value)}`,
  );
  return `convert_from(decode('${hexOf(value)}', 'hex'), 'UTF8')`;
}

const NUMERIC = /^-?[0-9]+(\.[0-9]+)?$/;
const INTEGER = /^-?[0-9]+$/;

export function literal(
  type: ColumnType,
  value: SqlValue,
  location: string,
  findings: Findings,
): string {
  if (value === null) return "null";
  if (type === "bool") {
    if (typeof value !== "boolean")
      throw new Error(`${location}: expected a boolean, got ${JSON.stringify(value)}`);
    return value ? "true" : "false";
  }
  if (typeof value !== "string")
    throw new Error(`${location}: expected text, got ${JSON.stringify(value)}`);
  switch (type) {
    case "int":
    case "minor":
      if (!INTEGER.test(value)) throw new Error(`${location}: "${value}" is not an integer`);
      return value;
    case "numeric":
      if (!NUMERIC.test(value)) throw new Error(`${location}: "${value}" is not a plain decimal`);
      return value;
    case "date":
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))
        throw new Error(`${location}: "${value}" is not a date`);
      return `${quoteText(value)}::date`;
    case "timestamp":
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2})?$/.test(value)) {
        throw new Error(`${location}: "${value}" is not a timestamp`);
      }
      return `${quoteText(value)}::timestamp`;
    case "timestamptz":
      return `${quoteText(value)}::timestamptz`;
    case "time":
      if (!/^[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(value))
        throw new Error(`${location}: "${value}" is not a time`);
      return `${quoteText(value)}::time`;
    case "code":
    case "text":
    case "currency":
    case "xyz":
      return textLiteral(value, location, findings);
  }
}

function compareValues(a: SqlValue, b: SqlValue, type: ColumnType): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "boolean" || typeof b === "boolean") return a === false ? -1 : 1;
  if (type === "int" || type === "numeric" || type === "minor") return Number(a) - Number(b);
  return a < b ? -1 : 1;
}

/** Rows sorted by the table's order columns (the primary key by default), byte order for text. */
export function sortRows(table: TableSpec, rows: readonly SqlRow[]): SqlRow[] {
  const order = table.orderBy ?? table.primaryKey;
  const types = order.map((name) => {
    const c = table.columns.find((col) => col.name === name);
    if (!c) throw new Error(`xpms.${table.name} orders by unknown column ${name}`);
    return c.type;
  });
  return [...rows].sort((x, y) => {
    for (let i = 0; i < order.length; i++) {
      const col = order[i] as string;
      const d = compareValues(x[col] ?? null, y[col] ?? null, types[i] as ColumnType);
      if (d !== 0) return d;
    }
    return 0;
  });
}

export function checkKeys(table: TableSpec, rows: readonly SqlRow[]): void {
  const keys = [table.primaryKey, ...(table.unique ?? [])];
  for (const key of keys) {
    const seen = new Set<string>();
    for (const row of rows) {
      const parts = key.map((k) => row[k] ?? null);
      if (parts.some((p) => p === null)) continue;
      const id = JSON.stringify(parts);
      if (seen.has(id)) throw new Error(`xpms.${table.name}: duplicate ${key.join(", ")} ${id}`);
      seen.add(id);
    }
  }
}

const BATCH = 250;

export function insertStatements(data: TableData, findings: Findings): string {
  const { table } = data;
  const columns = seededColumns(table);
  for (const row of data.rows) {
    for (const key of Object.keys(row)) {
      if (!columns.some((c) => c.name === key))
        throw new Error(`xpms.${table.name} has no seeded column ${key}`);
    }
  }
  checkKeys(table, data.rows);
  const rows = sortRows(table, data.rows);
  if (rows.length === 0) return `-- xpms.${table.name}: canon states no rows.\n`;
  const names = columns.map((c) => c.name).join(", ");
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map((row, j) => {
      const values = columns.map((c: ColumnSpec) => {
        const v = row[c.name];
        if (v === undefined)
          throw new Error(`xpms.${table.name} row ${i + j + 1} has no value for ${c.name}`);
        if (v === null && !c.nullable)
          throw new Error(`xpms.${table.name} row ${i + j + 1}: ${c.name} is required`);
        return literal(c.type, v, `xpms.${table.name}.${c.name} row ${i + j + 1}`, findings);
      });
      return `  (${values.join(", ")})`;
    });
    out.push(`insert into xpms.${table.name} (${names}) values\n${chunk.join(",\n")};\n`);
  }
  return out.join("\n");
}

function columnDdl(c: ColumnSpec): string {
  const parts = [c.name, SQL_TYPES[c.type]];
  if (c.generated !== undefined) parts.push(`generated always as ${c.generated} stored`);
  if (!c.nullable) parts.push("not null");
  if (c.references !== undefined) {
    const rule = c.onDelete === "cascade" ? " on delete cascade" : "";
    parts.push(`references xpms.${c.references}${rule}`);
  }
  if (c.check !== undefined) parts.push(`check (${c.check})`);
  return `  ${parts.join(" ")}`;
}

function isCovered(columns: readonly string[], table: TableSpec): boolean {
  const keys = [table.primaryKey, ...(table.unique ?? [])];
  return keys.some((k) => columns.every((c, i) => k[i] === c));
}

/** CREATE TABLE, comments and one supporting index per foreign key not already led by a key. */
export function tableDdl(table: TableSpec): string {
  const lines = table.columns.map(columnDdl);
  lines.push(`  primary key (${table.primaryKey.join(", ")})`);
  for (const u of table.unique ?? []) lines.push(`  unique (${u.join(", ")})`);
  for (const fk of table.foreignKeys ?? []) {
    lines.push(
      `  foreign key (${fk.columns.join(", ")}) references xpms.${fk.table} (${fk.targets.join(", ")})`,
    );
  }
  for (const ck of table.checks ?? []) lines.push(`  check (${ck})`);
  const out = [`create table xpms.${table.name} (\n${lines.join(",\n")}\n);`];
  out.push(`comment on table xpms.${table.name} is ${quoteText(table.comment)};`);
  for (const c of table.columns) {
    out.push(`comment on column xpms.${table.name}.${c.name} is ${quoteText(c.comment)};`);
  }
  const fkColumns: string[][] = [
    ...table.columns.filter((c) => c.references !== undefined).map((c) => [c.name]),
    ...(table.foreignKeys ?? []).map((fk) => [...fk.columns]),
  ];
  for (const cols of fkColumns) {
    if (isCovered(cols, table)) continue;
    out.push(
      `create index ${table.name}_${cols.join("_")}_idx on xpms.${table.name} (${cols.join(", ")});`,
    );
  }
  return `${out.join("\n")}\n`;
}
