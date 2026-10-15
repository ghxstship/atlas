/**
 * Compares catalog resources with the implemented schema (ADR 0023): nullability, column names and
 * types, enum values, create bodies against NOT NULL columns without defaults, and money columns.
 * The input is a read-only dump of `information_schema` and `pg_catalog` taken with
 * `SCHEMA_DUMP_SQL`; `scripts/contract-audit.ts` runs it and prints the findings.
 */
import type { ResourceSpec } from "./types.ts";

/** One query, read-only, that returns the whole dump as one JSON value. */
export const SCHEMA_DUMP_SQL = `
select json_build_object(
  'columns', (select json_agg(json_build_object(
      's', c.table_schema, 't', c.table_name, 'c', c.column_name, 'type', c.data_type,
      'udt', c.udt_name, 'udt_schema', c.udt_schema, 'nullable', c.is_nullable = 'YES',
      'default', c.column_default, 'generated', c.is_generated = 'ALWAYS' or c.is_identity = 'YES')
    order by c.table_schema, c.table_name, c.ordinal_position)
    from information_schema.columns c
    where c.table_schema in ('app', 'xpms', 'private', 'api_external')),
  'kinds', (select json_object_agg(n.nspname || '.' || cl.relname, cl.relkind)
    from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname in ('app', 'xpms', 'private', 'api_external') and cl.relkind in ('r', 'v', 'm', 'p')),
  'enums', (select json_object_agg(n.nspname || '.' || t.typname,
      (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid))
    from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype = 'e')
)`;

export interface DumpColumn {
  readonly s: string;
  readonly t: string;
  readonly c: string;
  readonly type: string;
  readonly udt: string;
  readonly udt_schema: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly generated: boolean;
}

export interface SchemaDump {
  readonly columns: readonly DumpColumn[];
  /** `schema.table` to its relkind: r table, p partitioned table, v view, m materialized view. */
  readonly kinds: Readonly<Record<string, string>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
}

export type FindingKind =
  | "unbuilt"
  | "audit_nullable"
  | "nullable"
  | "missing_column"
  | "extra_column"
  | "type"
  | "enum"
  | "create_missing"
  | "create_overrequired"
  | "create_underrequired"
  | "money";

export interface Finding {
  readonly kind: FindingKind;
  readonly field?: string;
  readonly detail?: string;
}

export interface ResourceAudit {
  readonly op: string;
  readonly module: string;
  readonly table: string;
  /** `table`, `view` or null when the source does not exist. */
  readonly source: "table" | "view" | null;
  readonly findings: readonly Finding[];
}

type Json = Record<string, unknown>;

/** Columns every tenant table has, which create bodies never carry. */
const BASE_COLUMNS = new Set([
  "id",
  "org_id",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
]);
/** Columns that are bookkeeping, never part of a read shape. */
const BOOKKEEPING = new Set(["deleted_at", "deleted_by"]);

function resolve(schemas: Record<string, Json>, x: Json | undefined): Json | undefined {
  if (x === undefined) return undefined;
  const ref = x["$ref"];
  if (typeof ref === "string") return resolve(schemas, schemas[ref.split("/").pop() as string]);
  return x;
}

function variants(schemas: Record<string, Json>, x: Json | undefined): Json[] {
  const r = resolve(schemas, x);
  if (r === undefined) return [];
  const list = (r["anyOf"] ?? r["oneOf"] ?? r["allOf"]) as Json[] | undefined;
  return list === undefined ? [r] : list.flatMap((y) => variants(schemas, y));
}

function isNullableField(schemas: Record<string, Json>, x: Json | undefined): boolean {
  return variants(schemas, x).some((v) => {
    const t = v["type"];
    return t === "null" || (Array.isArray(t) && t.includes("null"));
  });
}

function jsonTypes(schemas: Record<string, Json>, x: Json | undefined): string[] {
  return variants(schemas, x).flatMap((v) => {
    if ((v["properties"] as Json | undefined)?.["masked"] !== undefined) return ["masked"];
    const t = v["type"];
    const types = (Array.isArray(t) ? t : t === undefined ? ["any"] : [t]) as string[];
    return types.filter((y) => y !== "null");
  });
}

function enumValues(schemas: Record<string, Json>, x: Json | undefined): string[] | undefined {
  for (const v of variants(schemas, x)) {
    if (Array.isArray(v["enum"]))
      return (v["enum"] as unknown[]).filter((e) => e !== null).map(String);
  }
  return undefined;
}

function patternOf(schemas: Record<string, Json>, x: Json | undefined): string | undefined {
  for (const v of variants(schemas, x)) if (typeof v["pattern"] === "string") return v["pattern"];
  return undefined;
}

/** JSON Schema types a Postgres column can carry. */
function compatible(column: DumpColumn): readonly string[] {
  switch (column.type) {
    case "uuid":
    case "text":
    case "character varying":
    case "character":
    case "date":
    case "inet":
    case "cidr":
    case "time without time zone":
    case "time with time zone":
    case "timestamp with time zone":
    case "timestamp without time zone":
      return ["string"];
    case "bigint":
    case "integer":
    case "smallint":
      return ["integer"];
    case "numeric":
    case "double precision":
    case "real":
      return ["number", "integer", "string"];
    case "boolean":
      return ["boolean"];
    case "interval":
      return ["string", "integer"];
    case "jsonb":
    case "json":
      return ["object", "array", "string", "number", "integer", "boolean", "any"];
    case "ARRAY":
      return ["array"];
    default:
      return ["string"];
  }
}

function columnType(column: DumpColumn): string {
  return column.type === "USER-DEFINED" ? `${column.udt_schema}.${column.udt}` : column.type;
}

/** Audits one resource against the dump; `schemas` are the document's component schemas. */
export function auditResource(
  spec: ResourceSpec,
  schemas: Record<string, Json>,
  dump: SchemaDump,
  columnsByTable: ReadonlyMap<string, readonly DumpColumn[]>,
): ResourceAudit {
  const table = spec.def.table;
  const kind = dump.kinds[table];
  const base = { op: spec.op, module: spec.module, table };
  if (kind === undefined) return { ...base, source: null, findings: [{ kind: "unbuilt" }] };
  const isView = kind === "v" || kind === "m";
  const findings: Finding[] = [];
  const columns = columnsByTable.get(table) ?? [];
  const byName = new Map(columns.map((c) => [c.c, c]));
  const read = schemas[spec.def.name] ?? {};
  const props = (read["properties"] as Record<string, Json> | undefined) ?? {};
  const required = new Set((read["required"] as string[] | undefined) ?? []);

  for (const [field, prop] of Object.entries(props)) {
    const column = byName.get(field);
    if (column === undefined) {
      findings.push({ kind: "missing_column", field });
      continue;
    }
    if (!isView && column.nullable && required.has(field) && !isNullableField(schemas, prop)) {
      findings.push({
        kind: field === "created_by" || field === "updated_by" ? "audit_nullable" : "nullable",
        field,
      });
    }
    const types = jsonTypes(schemas, prop);
    const allowed = compatible(column);
    if (
      !types.includes("masked") &&
      !types.includes("any") &&
      !types.some((t) => allowed.includes(t))
    ) {
      findings.push({
        kind: "type",
        field,
        detail: `${types.join("|")} for ${columnType(column)}`,
      });
    }
    if (column.type === "USER-DEFINED") {
      const labels = dump.enums[`${column.udt_schema}.${column.udt}`];
      if (labels !== undefined) {
        const values = enumValues(schemas, prop);
        const pattern = patternOf(schemas, prop);
        if (values !== undefined) {
          const onlyDb = labels.filter((l) => !values.includes(l));
          const onlyContract = values.filter((v) => !labels.includes(v));
          if (onlyDb.length + onlyContract.length > 0) {
            findings.push({
              kind: "enum",
              field,
              detail: `${columnType(column)}: database only [${onlyDb.join(", ")}], contract only [${onlyContract.join(", ")}]`,
            });
          }
        } else if (pattern !== undefined) {
          const rejected = labels.filter((l) => !new RegExp(pattern).test(l));
          if (rejected.length > 0) {
            findings.push({
              kind: "enum",
              field,
              detail: `${columnType(column)}: the pattern rejects [${rejected.join(", ")}]`,
            });
          }
        }
      }
    }
    if (field.endsWith("_minor") && column.type !== "bigint" && column.type !== "integer") {
      findings.push({ kind: "money", field, detail: `stored as ${column.type}` });
    }
  }
  if (
    columns.some((c) => c.c.endsWith("_minor")) &&
    !columns.some((c) => c.c === "currency" || c.c.endsWith("_currency") || c.c === "currency_code")
  ) {
    findings.push({
      kind: "money",
      detail: "minor-unit columns without a currency column on the row",
    });
  }
  for (const column of columns) {
    if (!(column.c in props) && !BOOKKEEPING.has(column.c) && column.type !== "tsvector") {
      findings.push({
        kind: "extra_column",
        field: column.c,
        detail: `${columnType(column)}${column.nullable ? " null" : ""}`,
      });
    }
  }
  if (spec.verbs.includes("create") && !isView) {
    const create = schemas[`${spec.def.name}Create`] ?? {};
    const createProps = (create["properties"] as Record<string, Json> | undefined) ?? {};
    const createRequired = (create["required"] as string[] | undefined) ?? [];
    const pathParams = [...spec.path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
    for (const column of columns) {
      if (column.nullable || column.default !== null || column.generated) continue;
      if (BASE_COLUMNS.has(column.c) || column.c in createProps || pathParams.includes(column.c))
        continue;
      findings.push({ kind: "create_missing", field: column.c, detail: columnType(column) });
    }
    for (const field of Object.keys(createProps)) {
      const column = byName.get(field);
      if (
        column !== undefined &&
        !createRequired.includes(field) &&
        !column.nullable &&
        column.default === null &&
        !column.generated
      ) {
        findings.push({
          kind: "create_underrequired",
          field,
          detail: "column is NOT NULL without a default",
        });
      }
    }
    for (const field of createRequired) {
      const column = byName.get(field);
      if (column !== undefined && (column.nullable || column.default !== null)) {
        findings.push({
          kind: "create_overrequired",
          field,
          detail: column.nullable ? "column is nullable" : "column has a default",
        });
      }
    }
  }
  return { ...base, source: isView ? "view" : "table", findings };
}

/** Audits every resource of `specs` against the dump. */
export function auditCatalog(
  specs: readonly ResourceSpec[],
  document: unknown,
  dump: SchemaDump,
): ResourceAudit[] {
  const schemas = (document as { components: { schemas: Record<string, Json> } }).components
    .schemas;
  const columnsByTable = new Map<string, DumpColumn[]>();
  for (const c of dump.columns) {
    const key = `${c.s}.${c.t}`;
    columnsByTable.set(key, [...(columnsByTable.get(key) ?? []), c]);
  }
  return specs.map((spec) => auditResource(spec, schemas, dump, columnsByTable));
}
