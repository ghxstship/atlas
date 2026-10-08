/**
 * Declarative description of an xpms table. The DDL migration, the column
 * comments and the seed column lists are all generated from these specs, so a
 * column cannot exist without its comment or be seeded under another name.
 */

export type ColumnType =
  | "code"
  | "text"
  | "int"
  | "numeric"
  | "bool"
  | "date"
  | "timestamp"
  | "timestamptz"
  | "time"
  | "minor"
  | "currency"
  | "xyz";

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
  readonly comment: string;
  readonly nullable?: boolean;
  /** Target as "table(column)" inside xpms. */
  readonly references?: string;
  readonly check?: string;
  /** SQL expression for a stored generated column; generated columns are never seeded. */
  readonly generated?: string;
}

export interface TableSpec {
  readonly name: string;
  readonly comment: string;
  readonly columns: readonly ColumnSpec[];
  readonly primaryKey: readonly string[];
  readonly unique?: readonly (readonly string[])[];
  readonly checks?: readonly string[];
  /** Composite foreign keys: columns, target table and target columns. */
  readonly foreignKeys?: readonly {
    readonly columns: readonly string[];
    readonly table: string;
    readonly targets: readonly string[];
  }[];
  /** Columns the seed is sorted by; defaults to the primary key. */
  readonly orderBy?: readonly string[];
}

export const SQL_TYPES: Readonly<Record<ColumnType, string>> = {
  code: "xpms.canon_code",
  text: "xpms.canon_text",
  int: "integer",
  numeric: "numeric",
  bool: "boolean",
  date: "date",
  timestamp: "timestamp",
  timestamptz: "timestamptz",
  time: "time",
  minor: "bigint",
  currency: "xpms.currency_code",
  xyz: "xpms.xyz_tag",
};

export function seededColumns(table: TableSpec): ColumnSpec[] {
  return table.columns.filter((c) => c.generated === undefined);
}

export function columnSpec(table: TableSpec, name: string): ColumnSpec {
  const c = table.columns.find((col) => col.name === name);
  if (!c) throw new Error(`xpms.${table.name} has no column ${name}`);
  return c;
}
