import { quoteText } from "../sql.ts";
import type { ColumnEntry, ColumnMap, FieldType, SheetEntry } from "./column-map.ts";
import { STD_TABLES } from "./column-map.ts";
import { COVER_SHEET } from "./layout.ts";
import { TEMPLATE_CODE } from "./model.ts";

/**
 * Export views for the round-trip proof (Section 2.1). For every sheet:
 * - xpms.v_sheet_<key>: one row per source row with a column per sheet column,
 *   field columns read from their xpms home and computed columns reproduced in SQL;
 * - xpms.v_playbook_<key>: (source_row, cells), every cell normalized, which
 *   xpms.playbook_checksum hashes and the round-trip CLI writes back to .xlsx.
 */

export interface ViewSql {
  readonly name: string;
  readonly sql: string;
  readonly deps: readonly string[];
}

const NORMALIZERS: Readonly<Record<FieldType, string>> = {
  text: "xpms.pb_text(($)::text)",
  code: "xpms.pb_text(($)::text)",
  numeric: "xpms.pb_num(($)::numeric)",
  int: "xpms.pb_num(($)::numeric)",
  money: "xpms.pb_num(($)::numeric)",
  bool: "xpms.pb_bool(($)::boolean)",
  date: "xpms.pb_date(($)::date)",
  timestamp: "xpms.pb_ts(($)::timestamp)",
  time: "xpms.pb_time(($)::time)",
};

export function normalized(type: FieldType | undefined, expr: string): string {
  return NORMALIZERS[type ?? "text"].replace("$", expr);
}

function computedChain(entry: SheetEntry, base: string): string {
  const computed = entry.columns.filter((c) => c.disposition === "computed");
  const ctes = [`s0 as (${base})`];
  computed.forEach((c, i) => {
    ctes.push(`s${i + 1} as (select r.*, (${c.sql ?? "null"}) as ${c.key} from s${i} r)`);
  });
  return `with ${ctes.join(",\n")}\nselect * from s${computed.length}`;
}

function templateBase(entry: SheetEntry): string {
  const fields = entry.columns
    .map((c, i) => ({ c, ordinal: i + 1 }))
    .filter(({ c }) => c.disposition === "field")
    .map(
      ({ c, ordinal }) =>
        `max(xpms.pb_cell(v.value_text, v.value_kind)) filter (where v.column_ordinal = ${ordinal}) as ${c.key}`,
    );
  return [
    `select t.source_row${fields.map((f) => `, ${f}`).join("")}`,
    "from xpms.production_template_rows t",
    "left join xpms.production_template_values v",
    "  on v.template_code = t.template_code and v.sheet_name = t.sheet_name and v.source_row = t.source_row",
    `where t.template_code = ${quoteText(TEMPLATE_CODE)} and t.sheet_name = ${quoteText(entry.sheet)}`,
    "group by t.source_row",
  ].join("\n");
}

function stdBase(entry: SheetEntry): string {
  const table = STD_TABLES[entry.sheet];
  if (!table) throw new Error(`${entry.sheet} has no Standard Library table`);
  const fields = entry.columns
    .filter((c) => c.disposition === "field")
    .map((c) => (c.type === "money" ? `(r.${c.key}_minor / 100.0) as ${c.key}` : `r.${c.key}`));
  return `select r.source_row${fields.map((f) => `, ${f}`).join("")} from xpms.${table} r`;
}

function cellExpr(entry: SheetEntry, c: ColumnEntry): string {
  if (c.disposition === "presentation") return "''";
  const ref = `r.${c.key}`;
  if (entry.destination === "production-template" && c.disposition === "field")
    return `coalesce(${ref}, '')`;
  if (entry.destination === "canon-mirror" || entry.query !== undefined)
    return `coalesce(${ref}::text, '')`;
  return normalized(c.type, ref);
}

const DEP = /xpms\.v_sheet_([a-z0-9_]+)/g;

function deps(sql: string, own: string): string[] {
  return [...new Set([...sql.matchAll(DEP)].map((m) => `v_sheet_${m[1] ?? ""}`))].filter(
    (d) => d !== own,
  );
}

function exportComments(view: string): string[] {
  return [
    `comment on column xpms.${view}.source_row is 'Row number in the source sheet.';`,
    `comment on column xpms.${view}.cells is 'Every cell of the row in column order, normalized as the manifest checksum defines.';`,
  ];
}

export function sheetViews(entry: SheetEntry): ViewSql[] {
  const sheetView = `v_sheet_${entry.key}`;
  const exportView = `v_playbook_${entry.key}`;
  let body: string;
  if (entry.sheet === COVER_SHEET) {
    const cells = entry.columns.map(
      (_c, i) =>
        `coalesce(max(xpms.pb_cell(m.value_text, m.value_kind)) filter (where m.column_ordinal = ${i + 1}), '')`,
    );
    const sql = [
      `create view xpms.${exportView} with (security_invoker = true) as`,
      `select m.source_row, array[${cells.join(", ")}]::text[] as cells`,
      "from xpms.production_template_metadata m",
      `where m.template_code = ${quoteText(TEMPLATE_CODE)}`,
      "group by m.source_row;",
      `comment on view xpms.${exportView} is ${quoteText("Cover Page cells as stored template metadata, normalized for the round-trip proof.")};`,
      ...exportComments(exportView),
    ].join("\n");
    return [{ name: exportView, sql, deps: [] }];
  }
  if (entry.query !== undefined) body = entry.query;
  else if (entry.destination === "production-template")
    body = computedChain(entry, templateBase(entry));
  else if (entry.destination === "standard-library") body = computedChain(entry, stdBase(entry));
  else throw new Error(`${entry.sheet} needs an export query`);
  const sheetSql = [
    `create view xpms.${sheetView} with (security_invoker = true) as`,
    `${body};`,
    `comment on view xpms.${sheetView} is ${quoteText(`The Playbook ${entry.sheet} sheet as the database holds it: one row per source row, computed columns reproduced in SQL.`)};`,
    `comment on column xpms.${sheetView}.source_row is 'Row number in the source sheet.';`,
    ...entry.columns.map(
      (c) =>
        `comment on column xpms.${sheetView}.${c.key} is ${quoteText(`${c.header} (column ${c.letter}), ${c.disposition}.`)};`,
    ),
  ].join("\n");
  const cells = entry.columns.map((c) => cellExpr(entry, c));
  const exportSql = [
    `create view xpms.${exportView} with (security_invoker = true) as`,
    `select r.source_row::integer as source_row, array[${cells.join(", ")}]::text[] as cells`,
    `from xpms.${sheetView} r;`,
    `comment on view xpms.${exportView} is ${quoteText(`The Playbook ${entry.sheet} sheet exported from the database with every cell normalized, for the round-trip proof.`)};`,
    ...exportComments(exportView),
  ].join("\n");
  return [
    { name: sheetView, sql: sheetSql, deps: deps(body, sheetView) },
    { name: exportView, sql: exportSql, deps: [sheetView] },
  ];
}

/** Every view, ordered so a view follows the views it reads. */
export function playbookViews(map: ColumnMap): ViewSql[] {
  const all = map.sheets.flatMap(sheetViews);
  const byName = new Map(all.map((v) => [v.name, v]));
  const done = new Set<string>();
  const out: ViewSql[] = [];
  const visit = (v: ViewSql, stack: readonly string[]) => {
    if (done.has(v.name)) return;
    if (stack.includes(v.name)) throw new Error(`View cycle: ${[...stack, v.name].join(" -> ")}`);
    for (const d of v.deps) {
      const dep = byName.get(d);
      if (!dep) throw new Error(`${v.name} reads ${d}, which no sheet defines`);
      visit(dep, [...stack, v.name]);
    }
    done.add(v.name);
    out.push(v);
  };
  for (const v of all) visit(v, []);
  return out;
}

export function viewsMigration(map: ColumnMap): string {
  const views = playbookViews(map);
  return [
    "-- 0109_xpms_playbook_views.sql",
    "-- Generated by @xos/canon-import from canon/map/playbook-columns.yaml. Do not edit by hand.",
    "-- Round-trip export views (Section 2.1): xpms.v_sheet_<sheet> and xpms.v_playbook_<sheet>.",
    "",
    ...views.map((v) => `${v.sql}\n`),
  ].join("\n");
}
