import { fromMinorUnits } from "./model/values.ts";
import { normalizeNumber } from "./normalize.ts";
import type { SqlRow } from "./sql.ts";

/**
 * Compares the importer's output with the owner's reference seed
 * (design/xos-design-system/export/canon/0101_xpms_canon_seed.sql), table by
 * table. The reference seed is the expected output for the tables it defines;
 * every difference is reported with the rows that differ.
 */

export interface ReferenceTable {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (string | null)[][];
}

function parseTuple(text: string, start: number): { values: (string | null)[]; end: number } {
  const values: (string | null)[] = [];
  let i = start + 1;
  while (i < text.length) {
    while (text[i] === " " || text[i] === "\n") i += 1;
    if (text[i] === "'") {
      let v = "";
      i += 1;
      for (;;) {
        const ch = text[i];
        if (ch === undefined) throw new Error("Unterminated string in reference seed");
        if (ch === "'") {
          if (text[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        v += ch;
        i += 1;
      }
      values.push(v);
    } else {
      const m = /^[^,)]+/.exec(text.slice(i));
      const raw = (m?.[0] ?? "").trim();
      i += m?.[0].length ?? 0;
      values.push(raw.toUpperCase() === "NULL" ? null : raw);
    }
    while (text[i] === " ") i += 1;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] === ")") return { values, end: i + 1 };
    throw new Error(`Unexpected character "${text[i] ?? ""}" in reference seed tuple`);
  }
  throw new Error("Unterminated tuple in reference seed");
}

export function parseReferenceSeed(sql: string): ReferenceTable[] {
  const out: ReferenceTable[] = [];
  const re = /INSERT INTO (\w+) \(([^)]*)\) VALUES/g;
  for (let m = re.exec(sql); m !== null; m = re.exec(sql)) {
    const columns = (m[2] ?? "").split(",").map((c) => c.trim());
    const rows: (string | null)[][] = [];
    let i = re.lastIndex;
    for (;;) {
      while (/\s/.test(sql[i] ?? "")) i += 1;
      if (sql[i] !== "(") break;
      const t = parseTuple(sql, i);
      rows.push(t.values);
      i = t.end;
      while (/\s/.test(sql[i] ?? "")) i += 1;
      if (sql[i] === ",") i += 1;
      else break;
    }
    out.push({ table: m[1] ?? "", columns, rows });
  }
  return out;
}

type Mapper = (rows: ReadonlyMap<string, readonly SqlRow[]>) => (string | null)[][];

function pick(
  table: string,
  columns: readonly string[],
  transform: Readonly<Record<string, (v: string) => string>> = {},
): Mapper {
  return (tables) =>
    (tables.get(table) ?? []).map((r) =>
      columns.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return null;
        const s = typeof v === "boolean" ? String(v) : v;
        const t = transform[c];
        return t ? t(s) : s;
      }),
    );
}

const money = (v: string) => fromMinorUnits(v);

/** How each reference table is produced by the importer, in the reference column order. */
export const REFERENCE_MAPPERS: Readonly<Record<string, Mapper>> = {
  department: pick("dim_department", ["dept_code", "department"]),
  gl_account: (tables) =>
    (tables.get("dim_gl_account") ?? []).map((r) => {
      const code = String(r["account_code"]);
      const type = String(r["account_type"]);
      return [
        code,
        String(r["account_name"]),
        type,
        type === "Revenue" || type === "Expense" ? `${code.slice(1, 2)}000` : null,
      ];
    }),
  grade: pick("grade", ["code", "label", "sort_order"]),
  role_discipline: pick("role_discipline", ["name"]),
  role_rank: pick("role_rank", ["label"]),
  role: pick("role", ["role_code", "job_title", "discipline", "rank"]),
  overtime_rule: pick("overtime_rule", ["rule_id", "name", "ot_multiplier", "dt_multiplier"]),
  jurisdiction: pick("jurisdiction", [
    "jurisdiction_id",
    "level",
    "parent",
    "unit_system",
    "currency",
    "status",
    "note",
  ]),
  jurisdiction_code_set: pick("jurisdiction_code_set", [
    "jurisdiction_id",
    "code_set",
    "sort_order",
  ]),
  worker_classification: pick("worker_classification", [
    "code",
    "label",
    "is_employee",
    "payment_channel",
    "sort_order",
  ]),
  classification_document: pick("classification_document", [
    "worker_classification",
    "country",
    "document",
    "purpose",
  ]),
  pay_basis: pick("pay_basis", ["label"]),
  arrangement: pick("arrangement", ["label"]),
  pay_basis_classification: pick("pay_basis_classification", [
    "pay_basis",
    "worker_classification",
  ]),
  arrangement_classification: pick("arrangement_classification", [
    "arrangement",
    "worker_classification",
  ]),
  rate_card: pick(
    "rate_card",
    [
      "rate_card_id",
      "role_code",
      "worker_classification",
      "pay_basis",
      "arrangement",
      "standard_rate_minor",
      "min_grade_rate_minor",
      "max_grade_rate_minor",
      "per_diem_rate_minor",
      "overtime_rule_id",
    ],
    {
      standard_rate_minor: money,
      min_grade_rate_minor: money,
      max_grade_rate_minor: money,
      per_diem_rate_minor: money,
    },
  ),
  emergency_code: pick("emergency_code", ["code", "label", "emergency", "swatch", "sort_order"]),
  operational_domain: pick("operational_domain", ["domain", "sort_order"]),
  emergency_protocol: pick("emergency_protocol", ["record_key", "code", "domain"]),
  emergency_protocol_step: pick("emergency_protocol_step", ["record_key", "step_no", "body"]),
  agency_function: pick("agency_function", ["function", "label", "responder", "sort_order"]),
  wage_hour_rule: pick("wage_hour_rule", [
    "jurisdiction_id",
    "source",
    "weekly_ot_after_hours",
    "daily_ot_after_hours",
    "daily_dt_after_hours",
    "min_ot_multiplier",
    "min_dt_multiplier",
  ]),
  jurisdiction_agency: pick("jurisdiction_agency", [
    "jurisdiction_id",
    "function",
    "agency",
    "contact",
  ]),
  organization_type: pick("organization_type", ["label"]),
  classification_organization_type: pick("classification_organization_type", [
    "worker_classification",
    "organization_type",
  ]),
};

function norm(v: string | null): string {
  if (v === null) return "\u0000";
  return /^-?[0-9]+(\.[0-9]+)?$/.test(v) ? normalizeNumber(Number(v)) : v;
}

export interface ReferenceDiff {
  readonly table: string;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

/** Rows in the reference but not produced (missing) and produced but not in the reference (extra). */
export function compareWithReference(
  reference: readonly ReferenceTable[],
  tables: ReadonlyMap<string, readonly SqlRow[]>,
): ReferenceDiff[] {
  return reference.map((ref) => {
    const mapper = REFERENCE_MAPPERS[ref.table];
    if (!mapper)
      return { table: ref.table, missing: ["no importer mapping for this table"], extra: [] };
    const key = (row: readonly (string | null)[]) => JSON.stringify(row.map(norm));
    const ours = mapper(tables).map(key);
    const theirs = ref.rows.map(key);
    const missing = theirs.filter((t) => !ours.includes(t));
    const extra = ours.filter((o) => !theirs.includes(o));
    return { table: ref.table, missing, extra };
  });
}
