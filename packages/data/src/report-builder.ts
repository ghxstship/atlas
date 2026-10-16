import type { XosClient } from "./client.ts";
import { nullAwareSum } from "./finance.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * The report builder (Section 4.6.4, A33 on A18's report definitions, 0550): a source, fields with
 * NULL-aware aggregates, filters, one grouping and a chart. A preview runs as the viewer, so row
 * level security and field masking apply; money sums are blank while any input is unpriced and the
 * unpriced inputs are counted beside them, never summed as zero (Section 3.7). Saved runs are queued
 * through app.run_report (reports.ts).
 */

type Raw = Record<string, unknown>;

export type FieldType = "text" | "number" | "money" | "date";
export type Aggregate = "None" | "Count" | "Sum" | "Average" | "Minimum" | "Maximum";
export type FilterOperator =
  "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "is_null" | "contains";
export type ChartType = "Table" | "Bar" | "Line" | "Area" | "Pie" | "Number";

export const AGGREGATES: readonly Aggregate[] = [
  "None",
  "Count",
  "Sum",
  "Average",
  "Minimum",
  "Maximum",
];
export const FILTER_OPERATORS: readonly FilterOperator[] = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is_null",
  "contains",
];
export const CHART_TYPES: readonly ChartType[] = ["Table", "Bar", "Line", "Area", "Pie", "Number"];

export interface SourceField {
  /** Column of the source relation; the catalog key of its label is `fields.<source>.<key>`. */
  readonly key: string;
  readonly type: FieldType;
}

export interface ReportSource {
  readonly code: string;
  /** Table or security_invoker view read as the viewer. */
  readonly relation: string;
  /** Column holding the currency of every money field, when there are any. */
  readonly currencyColumn?: string;
  /** Column scoping rows to the org. */
  readonly orgColumn: string;
  readonly fields: readonly SourceField[];
}

/** What each A18 report source reads and which of its columns a report may use. */
export const REPORT_SOURCES: readonly ReportSource[] = [
  {
    code: "records",
    relation: "records",
    orgColumn: "org_id",
    fields: [
      { key: "record_kind", type: "text" },
      { key: "record_state", type: "text" },
      { key: "phase_code", type: "text" },
      { key: "title", type: "text" },
      { key: "record_number", type: "number" },
      { key: "due_at", type: "date" },
      { key: "created_at", type: "date" },
    ],
  },
  {
    code: "finance",
    relation: "budget_line_facts",
    orgColumn: "project_id",
    currencyColumn: "currency_code",
    fields: [
      { key: "account_code", type: "text" },
      { key: "dept_code", type: "text" },
      { key: "cost_center_code", type: "text" },
      { key: "line_type", type: "text" },
      { key: "description", type: "text" },
      { key: "extended_minor", type: "money" },
      { key: "actual_minor", type: "money" },
    ],
  },
  {
    code: "crew",
    relation: "shifts",
    orgColumn: "org_id",
    fields: [
      { key: "role_code", type: "text" },
      { key: "shift_state", type: "text" },
      { key: "starts_at", type: "date" },
      { key: "ends_at", type: "date" },
    ],
  },
  {
    code: "procurement",
    relation: "purchase_order_totals",
    orgColumn: "project_id",
    currencyColumn: "currency_code",
    fields: [
      { key: "lines_total_minor", type: "money" },
      { key: "approved_changes_minor", type: "money" },
      { key: "unpriced_count", type: "number" },
    ],
  },
  {
    code: "assets",
    relation: "asset_units",
    orgColumn: "org_id",
    fields: [
      { key: "asset_tag", type: "text" },
      { key: "asset_state", type: "text" },
      { key: "condition_enum_id", type: "text" },
      { key: "created_at", type: "date" },
    ],
  },
  {
    code: "incidents",
    relation: "incidents",
    orgColumn: "org_id",
    fields: [
      { key: "title", type: "text" },
      { key: "incident_state", type: "text" },
      { key: "severity_enum_id", type: "text" },
      { key: "incident_number", type: "number" },
      { key: "occurred_at", type: "date" },
    ],
  },
  {
    code: "custom_object",
    relation: "custom_object_records",
    orgColumn: "org_id",
    fields: [
      { key: "title", type: "text" },
      { key: "created_at", type: "date" },
    ],
  },
];

export function sourceOf(code: string): ReportSource | undefined {
  return REPORT_SOURCES.find((s) => s.code === code);
}

/** Aggregates a field type allows: counts for anything, sums and averages for numbers and money. */
export function aggregatesFor(type: FieldType): readonly Aggregate[] {
  if (type === "number" || type === "money") return AGGREGATES;
  if (type === "date") return ["None", "Count", "Minimum", "Maximum"];
  return ["None", "Count"];
}

export interface ReportFieldSpec {
  readonly field: string;
  readonly aggregate: Aggregate;
}

export interface ReportFilterSpec {
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: string | null;
}

export interface ReportDefinition {
  readonly id: string | null;
  readonly name: string;
  readonly sourceCode: string;
  readonly customObjectTypeId: string | null;
  readonly chart: ChartType;
  readonly groupBy: string | null;
  readonly shared: boolean;
  readonly mine: boolean;
  readonly fields: readonly ReportFieldSpec[];
  readonly filters: readonly ReportFilterSpec[];
}

async function rows(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<Raw[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as Raw[] | null) ?? []);
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A saved definition with its fields and filters, or not-found when the viewer cannot read it. */
export async function getReportDefinition(
  db: XosClient,
  input: { readonly id: string; readonly membershipId: string },
): Promise<Result<ReportDefinition>> {
  const [defs, fields, filters] = await Promise.all([
    rows(
      untyped(db)
        .from("report_definitions")
        .select(
          "id, name, source_code, custom_object_type_id, chart, group_by_field, shared, membership_id",
        )
        .eq("id", input.id)
        .is("deleted_at", null),
    ),
    rows(
      untyped(db)
        .from("report_fields")
        .select("field, aggregate, position")
        .eq("report_definition_id", input.id)
        .is("deleted_at", null)
        .order("position"),
    ),
    rows(
      untyped(db)
        .from("report_filters")
        .select("field, operator, value_text")
        .eq("report_definition_id", input.id)
        .is("deleted_at", null)
        .order("created_at"),
    ),
  ]);
  if (!defs.ok) return defs;
  if (!fields.ok) return fields;
  if (!filters.ok) return filters;
  const d = defs.data[0];
  if (!d) return fail({ kind: "not-found" });
  return ok({
    id: str(d["id"]),
    name: str(d["name"]),
    sourceCode: str(d["source_code"]),
    customObjectTypeId: strOrNull(d["custom_object_type_id"]),
    chart: str(d["chart"]) as ChartType,
    groupBy: strOrNull(d["group_by_field"]),
    shared: d["shared"] === true,
    mine: str(d["membership_id"]) === input.membershipId,
    fields: fields.data.map((f) => ({
      field: str(f["field"]),
      aggregate: str(f["aggregate"]) as Aggregate,
    })),
    filters: filters.data.map((f) => ({
      field: str(f["field"]),
      operator: str(f["operator"]) as FilterOperator,
      value: strOrNull(f["value_text"]),
    })),
  });
}

/**
 * Saves a definition the viewer owns: creates it or updates it, then replaces its fields and filters
 * (the old rows are soft deleted so the history keeps them). Returns the definition id.
 */
export async function saveReportDefinition(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly membershipId: string;
    readonly definition: ReportDefinition;
  },
): Promise<Result<string>> {
  const d = input.definition;
  const values = {
    name: d.name.trim(),
    chart: d.chart,
    group_by_field: d.groupBy,
    shared: d.shared,
  };
  let id = d.id;
  if (id === null) {
    const { data, error } = await untyped(db)
      .from("report_definitions")
      .insert({
        ...values,
        org_id: input.orgId,
        membership_id: input.membershipId,
        source_code: d.sourceCode,
        custom_object_type_id: d.customObjectTypeId,
      })
      .select("id")
      .single();
    if (error) return fail(toDataError(error));
    id = str((data as Raw)["id"]);
  } else {
    const { data, error } = await untyped(db)
      .from("report_definitions")
      .update(values)
      .eq("id", id)
      .select("id");
    if (error) return fail(toDataError(error));
    if (((data as Raw[] | null) ?? []).length === 0) return fail({ kind: "not-found" });
    const stamp = new Date().toISOString();
    for (const table of ["report_fields", "report_filters"]) {
      const cleared = await untyped(db)
        .from(table)
        .update({ deleted_at: stamp })
        .eq("report_definition_id", id)
        .is("deleted_at", null);
      if (cleared.error) return fail(toDataError(cleared.error));
    }
  }
  if (d.fields.length > 0) {
    const { error } = await untyped(db)
      .from("report_fields")
      .insert(
        d.fields.map((f, i) => ({
          report_definition_id: id,
          field: f.field,
          aggregate: f.aggregate,
          position: i + 1,
        })),
      );
    if (error) return fail(toDataError(error));
  }
  if (d.filters.length > 0) {
    const { error } = await untyped(db)
      .from("report_filters")
      .insert(
        d.filters.map((f) => ({
          report_definition_id: id,
          field: f.field,
          operator: f.operator,
          value_text: f.value,
        })),
      );
    if (error) return fail(toDataError(error));
  }
  return ok(id);
}

export async function deleteReportDefinition(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("report_definitions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return ((data as Raw[] | null) ?? []).length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

// Preview ----------------------------------------------------------------------------------------------

/** One computed cell: a value, or a money total with its currency and unpriced count. */
export type PreviewCell =
  | { readonly kind: "value"; readonly value: string | number | null }
  | {
      readonly kind: "money";
      readonly totalMinor: number | null;
      readonly currency: string;
      readonly unpricedCount: number;
    };

export interface PreviewColumn {
  readonly field: string;
  readonly aggregate: Aggregate;
  readonly type: FieldType;
}

export interface ReportPreview {
  readonly columns: readonly PreviewColumn[];
  /** One row per group (or per source row when nothing aggregates), keyed like `columns`. */
  readonly rows: readonly {
    readonly group: string | null;
    readonly cells: readonly PreviewCell[];
  }[];
  /** Source rows read, at most PREVIEW_LIMIT. */
  readonly sourceRows: number;
  readonly truncated: boolean;
}

export const PREVIEW_LIMIT = 2000;

type Builder = {
  eq(c: string, v: unknown): Builder;
  neq(c: string, v: unknown): Builder;
  lt(c: string, v: unknown): Builder;
  lte(c: string, v: unknown): Builder;
  gt(c: string, v: unknown): Builder;
  gte(c: string, v: unknown): Builder;
  in(c: string, v: readonly unknown[]): Builder;
  is(c: string, v: null): Builder;
  ilike(c: string, v: string): Builder;
  limit(n: number): Builder;
} & PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;

function applyFilter(query: Builder, filter: ReportFilterSpec): Builder {
  const v = filter.value ?? "";
  switch (filter.operator) {
    case "eq":
      return query.eq(filter.field, v);
    case "ne":
      return query.neq(filter.field, v);
    case "lt":
      return query.lt(filter.field, v);
    case "lte":
      return query.lte(filter.field, v);
    case "gt":
      return query.gt(filter.field, v);
    case "gte":
      return query.gte(filter.field, v);
    case "in":
      return query.in(
        filter.field,
        v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      );
    case "is_null":
      return query.is(filter.field, null);
    case "contains":
      return query.ilike(filter.field, `%${v.replace(/[%_]/g, "")}%`);
  }
}

const numeric = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : typeof v === "number" ? v : Number(v);

function aggregateValue(
  values: readonly unknown[],
  aggregate: Aggregate,
  type: FieldType,
): string | number | null {
  if (aggregate === "Count") return values.filter((v) => v !== null && v !== undefined).length;
  if (aggregate === "None") return (values[0] as string | number | null | undefined) ?? null;
  if (type === "date") {
    const dates = values.filter((v): v is string => typeof v === "string").sort();
    return aggregate === "Minimum" ? (dates[0] ?? null) : (dates[dates.length - 1] ?? null);
  }
  const nums = values.map(numeric);
  // A blank number makes the aggregate blank: it is unknown, never zero (Section 3.7).
  if (nums.some((n) => n === null)) return null;
  const known = nums as number[];
  if (known.length === 0) return null;
  switch (aggregate) {
    case "Sum":
      return known.reduce((s, n) => s + n, 0);
    case "Average":
      return Math.round((known.reduce((s, n) => s + n, 0) / known.length) * 100) / 100;
    case "Minimum":
      return Math.min(...known);
    case "Maximum":
      return Math.max(...known);
  }
}

/**
 * Runs a definition as the viewer and aggregates in memory: up to PREVIEW_LIMIT source rows, grouped
 * by `groupBy` (and by currency when a money field is shown, so currencies never mix).
 */
export async function previewReport(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectIds: readonly string[];
    readonly definition: ReportDefinition;
  },
): Promise<Result<ReportPreview>> {
  const d = input.definition;
  const source = sourceOf(d.sourceCode);
  if (!source) return fail({ kind: "invalid", message: `Unknown report source ${d.sourceCode}.` });
  const known = new Map(source.fields.map((f) => [f.key, f]));
  const fields = d.fields.filter((f) => known.has(f.field));
  if (fields.length === 0) return ok({ columns: [], rows: [], sourceRows: 0, truncated: false });
  const columns: PreviewColumn[] = fields.map((f) => ({
    field: f.field,
    aggregate: f.aggregate,
    type: (known.get(f.field) as SourceField).type,
  }));
  const hasMoney = columns.some((c) => c.type === "money");
  const group = d.groupBy !== null && known.has(d.groupBy) ? d.groupBy : null;
  const select = [
    ...new Set([
      ...fields.map((f) => f.field),
      ...(group ? [group] : []),
      ...(hasMoney && source.currencyColumn ? [source.currencyColumn] : []),
    ]),
  ];
  if (source.orgColumn === "project_id" && input.projectIds.length === 0) {
    return ok({ columns, rows: [], sourceRows: 0, truncated: false });
  }
  let query = untyped(db).from(source.relation).select(select.join(", ")) as unknown as Builder;
  query =
    source.orgColumn === "project_id"
      ? query.in("project_id", input.projectIds)
      : query.eq(source.orgColumn, input.orgId);
  if (source.relation !== "budget_line_facts" && source.relation !== "purchase_order_totals") {
    query = query.is("deleted_at", null);
  }
  if (d.sourceCode === "custom_object" && d.customObjectTypeId) {
    query = query.eq("custom_object_type_id", d.customObjectTypeId);
  }
  for (const filter of d.filters) {
    if (known.has(filter.field)) query = applyFilter(query, filter);
  }
  const read = await rows(query.limit(PREVIEW_LIMIT + 1));
  if (!read.ok) return read;
  const truncated = read.data.length > PREVIEW_LIMIT;
  const data = truncated ? read.data.slice(0, PREVIEW_LIMIT) : read.data;
  const aggregating = group !== null || columns.some((c) => c.aggregate !== "None");
  const currencyOf = (r: Raw) =>
    source.currencyColumn ? str(r[source.currencyColumn]).trim() : "";
  const cellsFor = (members: readonly Raw[]): PreviewCell[] =>
    columns.map((c) => {
      const values = members.map((m) => m[c.field] ?? null);
      if (c.type === "money") {
        const currency = members[0] ? currencyOf(members[0]) : "";
        if (c.aggregate === "Sum" || (c.aggregate === "None" && !aggregating)) {
          const sum = nullAwareSum(values.map(numeric));
          return {
            kind: "money",
            totalMinor: sum.total,
            currency,
            unpricedCount: sum.unpricedCount,
          };
        }
        const value = aggregateValue(values, c.aggregate, c.type);
        if (c.aggregate === "Count") return { kind: "value", value };
        return {
          kind: "money",
          totalMinor: typeof value === "number" ? Math.round(value) : null,
          currency,
          unpricedCount: values.filter((v) => numeric(v) === null).length,
        };
      }
      return { kind: "value", value: aggregateValue(values, c.aggregate, c.type) };
    });
  if (!aggregating) {
    return ok({
      columns,
      rows: data.map((r) => ({ group: null, cells: cellsFor([r]) })),
      sourceRows: data.length,
      truncated,
    });
  }
  const groups = new Map<string, { label: string | null; members: Raw[] }>();
  for (const r of data) {
    const label = group
      ? r[group] === null || r[group] === undefined
        ? null
        : str(r[group])
      : null;
    const key = `${label ?? ""}|${hasMoney ? currencyOf(r) : ""}`;
    const g = groups.get(key) ?? { label, members: [] };
    g.members.push(r);
    groups.set(key, g);
  }
  return ok({
    columns,
    rows: [...groups.values()]
      .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "", "en", { numeric: true }))
      .map((g) => ({ group: g.label, cells: cellsFor(g.members) })),
    sourceRows: data.length,
    truncated,
  });
}

/** The preview as CSV, money in major units of its currency (its own decimals), blanks left blank. */
export function previewCsv(
  preview: ReportPreview,
  headers: readonly string[],
  groupHeader: string | null,
): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const cell = (c: PreviewCell): string => {
    if (c.kind === "value") return c.value === null ? "" : String(c.value);
    if (c.totalMinor === null) return "";
    const digits = c.currency
      ? (new Intl.NumberFormat("en", { style: "currency", currency: c.currency }).resolvedOptions()
          .maximumFractionDigits ?? 2)
      : 2;
    return `${(c.totalMinor / 10 ** digits).toFixed(digits)} ${c.currency}`.trim();
  };
  const lines = [[...(groupHeader ? [groupHeader] : []), ...headers].map(escape).join(",")];
  for (const r of preview.rows) {
    lines.push(
      [...(groupHeader ? [r.group ?? ""] : []), ...r.cells.map(cell)].map(escape).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
