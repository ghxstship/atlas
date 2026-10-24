/**
 * The denormalization register model (Section 3.15, ADR 0002, ADR 0068, gate 29). The register lists every stored
 * derived value and materialized view kept for measured performance, and the reviewed allow-lists the pgTAP catalog
 * lints read: column names that describe the row itself, JSON columns with their ADR 0002 exception, array columns,
 * restated parent columns, stored values named like totals, and the `app` tables without the ADR 0002 tenant
 * columns. Pure types and checks; docs/adr/denormalization-register.yaml is the source.
 */

/**
 * Why a json or jsonb column is allowed. The first three are the ADR 0002 exceptions; `registered` points at a
 * derived entry that carries its reason, and `finding` marks a violation with an open finding.
 */
export const JSON_EXCEPTIONS = [
  "rich-text",
  "audit-diff",
  "provider-payload",
  "registered",
  "finding",
] as const;
export type JsonException = (typeof JSON_EXCEPTIONS)[number];

/**
 * Why a stored value named like a total is not an unregistered derived value: it is `registered` above, a `fact`
 * fixed when something happened that later rows cannot reproduce, an `input` a person, a provider or the canon sets,
 * or a `finding`.
 */
export const STORED_KINDS = ["registered", "fact", "input", "finding"] as const;
export type StoredKind = (typeof STORED_KINDS)[number];

/**
 * Why a column that shares its name and type with a column of a referenced table is allowed: `registered` above, a
 * `fact` kept as it was when written while the parent can change later, the row's `own` value (it can differ from
 * the parent's, or the row needs it without the link, which is optional), or a `finding`.
 */
export const RESTATED_KINDS = ["registered", "fact", "own", "finding"] as const;
export type RestatedKind = (typeof RESTATED_KINDS)[number];

/** Why an array column is allowed: a short closed set or payload read whole, or a `finding`. */
export const ARRAY_KINDS = ["reviewed", "finding"] as const;
export type ArrayKind = (typeof ARRAY_KINDS)[number];

/**
 * Why an `app` table has no `org_id` or audit columns: it is a canonical `identity` row (Section 4.8.1), owned by a
 * person (ADR 0019 item 10, ADR 0033 decision 69), or `platform`-wide.
 */
export const TABLE_KINDS = ["identity", "person-owned", "platform"] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

/** A stored derived value or materialized view Section 3.15 allows for measured performance. */
export interface DerivedEntry {
  /** Tables or columns, `schema.table` or `schema.table.column`. */
  readonly objects: readonly string[];
  readonly source: string;
  readonly refresh: string;
  readonly reason: string;
  /** ADR number, four digits. */
  readonly adr: string;
}

interface Reviewed<K extends string> {
  readonly kind: K;
  readonly note: string;
  /** Finding id, required when the kind is `finding`. */
  readonly finding: string | null;
}

export interface JsonEntry extends Reviewed<JsonException> {
  readonly column: string;
}

export interface ArrayEntry extends Reviewed<ArrayKind> {
  readonly column: string;
}

/** One restatement: a column can restate a column of more than one referenced table, each listed on its own. */
export interface RestatedEntry extends Reviewed<RestatedKind> {
  readonly column: string;
  /** The referenced table's column it restates; that table can be in any schema, such as `auth`. */
  readonly parent: string;
}

export interface StoredEntry extends Reviewed<StoredKind> {
  readonly column: string;
}

/** An `app` table without the tenant columns, which pgTAP 0202 would otherwise refuse. */
export interface TableEntry {
  readonly table: string;
  readonly kind: TableKind;
  readonly note: string;
}

/** A column name that always describes the row itself, so the restated-column lint never compares it. */
export interface OwnName {
  readonly name: string;
  readonly note: string;
}

export interface DenormalizationRegister {
  readonly derived: readonly DerivedEntry[];
  readonly ownNames: readonly OwnName[];
  readonly json: readonly JsonEntry[];
  readonly arrays: readonly ArrayEntry[];
  readonly restated: readonly RestatedEntry[];
  readonly stored: readonly StoredEntry[];
  readonly tenantExceptions: readonly TableEntry[];
}

/** Schemas the catalog lints cover. */
export const LINTED_SCHEMAS = ["app", "private", "xpms"] as const;

const TABLE = /^(app|private|xpms)\.[a-z][a-z0-9_]*$/;
const COLUMN = /^(app|private|xpms)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const ANY_COLUMN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const FINDING = /^[A-Z][A-Z0-9]*-\d{3}$/;
const NAME = /^[a-z][a-z0-9_]*$/;

export function isTableName(value: string): boolean {
  return TABLE.test(value);
}

export function isColumnName(value: string): boolean {
  return COLUMN.test(value);
}

/** The table part of `schema.table.column`. */
export function tableOf(column: string): string {
  return column.slice(0, column.lastIndexOf("."));
}

/** The column part of `schema.table.column`. */
export function columnOf(column: string): string {
  return column.slice(column.lastIndexOf(".") + 1);
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) (seen.has(value) ? twice : seen).add(value);
  return [...twice].sort();
}

function unsorted(values: readonly string[]): boolean {
  const sorted = [...values].sort();
  return values.some((value, i) => value !== sorted[i]);
}

/**
 * Every problem in a register, empty when it is consistent: names outside the linted schemas, an entry listed twice,
 * a list out of order (sorted lists keep merges clean), a `registered` entry with no derived entry naming it, a
 * `finding` entry without a finding id, a restated column with an own name, and a restated column that names itself,
 * another column name or a column of its own table as its parent.
 */
export function registerProblems(register: DenormalizationRegister): string[] {
  const problems: string[] = [];
  const derivedObjects = new Set(register.derived.flatMap((d) => d.objects));
  const registeredIn = (column: string) =>
    derivedObjects.has(column) || derivedObjects.has(tableOf(column));

  for (const d of register.derived) {
    for (const o of d.objects) {
      if (!isTableName(o) && !isColumnName(o))
        problems.push(`derived: ${o} is not a table or column name`);
    }
  }

  const own = register.ownNames.map((n) => n.name);
  for (const name of duplicates(own)) problems.push(`own_names: ${name} is listed twice`);
  if (unsorted(own)) problems.push("own_names: entries are not sorted by name");
  for (const name of own) if (!NAME.test(name)) problems.push(`own_names: ${name} is not a column name`);

  const lists: [string, readonly (Reviewed<string> & { name: string; column: string })[]][] = [
    ["json", register.json.map((e) => ({ ...e, name: e.column }))],
    ["arrays", register.arrays.map((e) => ({ ...e, name: e.column }))],
    ["restated", register.restated.map((e) => ({ ...e, name: `${e.column} ${e.parent}` }))],
    ["stored", register.stored.map((e) => ({ ...e, name: e.column }))],
  ];
  for (const [list, entries] of lists) {
    const names = entries.map((e) => e.name);
    for (const name of duplicates(names)) problems.push(`${list}: ${name} is listed twice`);
    if (unsorted(names)) problems.push(`${list}: entries are not sorted by name`);
    for (const e of entries) {
      if (!isColumnName(e.column)) problems.push(`${list}: ${e.column} is not a column name`);
      if (e.kind === "registered" && !registeredIn(e.column)) {
        problems.push(`${list}: ${e.name} is marked registered but no derived entry names it`);
      }
      if (e.kind === "finding" && e.finding === null)
        problems.push(`${list}: ${e.name} needs a finding id`);
      if (e.finding !== null && !FINDING.test(e.finding)) {
        problems.push(
          `${list}: ${e.name} names finding ${e.finding}, which is not an id like A108-001`,
        );
      }
    }
  }

  for (const e of register.restated) {
    if (own.includes(columnOf(e.column)))
      problems.push(`restated: ${e.column} has a name the lint never compares (own_names)`);
    if (!ANY_COLUMN.test(e.parent))
      problems.push(`restated: ${e.column} names parent ${e.parent}, not a column`);
    else if (tableOf(e.parent) === tableOf(e.column)) {
      problems.push(`restated: ${e.column} names a column of its own table as its parent`);
    } else if (columnOf(e.parent) !== columnOf(e.column)) {
      problems.push(`restated: ${e.column} and its parent ${e.parent} have different column names`);
    }
  }

  const tables = register.tenantExceptions.map((e) => e.table);
  for (const table of duplicates(tables))
    problems.push(`tenant_exceptions: ${table} is listed twice`);
  if (unsorted(tables)) problems.push("tenant_exceptions: entries are not sorted by name");
  for (const table of tables) {
    if (!isTableName(table) || !table.startsWith("app."))
      problems.push(`tenant_exceptions: ${table} is not an app table name`);
  }
  return problems;
}
