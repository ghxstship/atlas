import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { SqlRow } from "./sql.ts";

/**
 * Owner decision 25 (2026-10-19, canon/rulings/decision-25.yaml): how Playbook to Bible differences
 * resolve. The Bible wins on structure (codes, states, labels, hierarchy); values the Bible lacks are
 * imported and marked as from the Playbook; labels that differ only in casing or punctuation follow the
 * Bible; status labels that are not states map to the closest existing state, and no state is added.
 * Bible inconsistencies (RRR-66) are not covered here: owner decision 39 settles them (decision39.ts), and
 * a difference neither decision explains stays listed as deferred.
 */

export type Outcome =
  "bible-kept" | "playbook-imported" | "mapped-to-existing" | "ruled" | "deferred";

export type Basis =
  | "casing-or-punctuation"
  | "bible-label"
  | "bible-states-value"
  | "bible-lacks-value"
  | "not-added"
  | "closest-state"
  | "closest-value"
  | "same-label"
  | "owner-ruling"
  | "deferred";

export interface Resolution {
  readonly outcome: Outcome;
  readonly basis: Basis;
  /** The value canon holds after the decision; null when canon holds none. */
  readonly canon: string | null;
  readonly note: string;
  /** The owner decision a label mapping names when it is not decision 25 (xpms.label_mapping.decision). */
  readonly decision?: string;
}

export interface LibraryLabel {
  readonly domain: string;
  readonly label: string;
  readonly canon_domain: string;
  readonly canon_value: string;
  readonly basis: "closest-state" | "closest-value";
  readonly note: string;
}

export interface TemplateLabel {
  readonly domain: string;
  readonly label: string;
  readonly canon_value: string;
  readonly basis: "closest-state" | "closest-value" | "same-label";
  readonly applies_to: string;
  readonly note?: string;
}

export interface Decision25 {
  readonly decision: string;
  readonly decided_on: string;
  readonly linear: string;
  readonly accepted_findings: Readonly<Record<string, string>>;
  readonly playbook_only_rows: readonly {
    readonly sheet: string;
    readonly key: string;
    readonly domain: string;
    readonly canon_value: string;
    readonly note: string;
  }[];
  readonly library_labels: readonly LibraryLabel[];
  readonly deferred: readonly {
    readonly sheet: string;
    readonly key: string;
    readonly question: string;
    readonly note: string;
  }[];
  readonly template_labels: readonly TemplateLabel[];
}

const KEYS: readonly (keyof Decision25)[] = [
  "decision",
  "decided_on",
  "linear",
  "accepted_findings",
  "playbook_only_rows",
  "library_labels",
  "deferred",
  "template_labels",
];

export function parseDecision25(text: string): Decision25 {
  const doc = parse(text) as Partial<Decision25> | null;
  if (!doc || typeof doc !== "object") throw new Error("Decision 25 file is empty");
  const missing = KEYS.filter((k) => doc[k] === undefined);
  if (missing.length > 0) throw new Error(`Decision 25 file lacks ${missing.join(", ")}`);
  return doc as Decision25;
}

export function loadDecision25(canonDir: string): Decision25 {
  return parseDecision25(readFileSync(join(canonDir, "rulings", "decision-25.yaml"), "utf8"));
}

/** Text with casing, punctuation and spacing removed, for the casing-or-punctuation rule. */
export function letters(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Canon columns that carry structure (codes, labels, hierarchy) rather than descriptive values. */
const STRUCTURE = new Set([
  "dim_department.department",
  "dim_department.dept_code",
  "dim_discipline.discipline",
  "dim_discipline.disc_code",
  "dim_discipline.dept_code",
  "dim_category.category",
  "dim_category.cat_urid",
  "dim_gl_account.account_code",
  "dim_gl_account.account_name",
  "dim_gl_account.account_type",
  "dim_gl_account.tax_type",
  "dim_cost_center_template.cost_center_id",
  "dim_cost_center_template.cost_center",
  "dim_cost_center_template.kind",
  "dim_cost_center_template.scope_code",
  "dim_team.team_id",
  "dim_team.team",
  "dim_team.dept_code",
  "dim_counterparty_type.counterparty_type",
  "elements.element_id",
  "elements.urid",
  "elements.item",
  "elements.kind",
  "elements.xyz",
  "elements.unit_basis",
  "elements.tier_code",
  "elements.default_cost_center",
  "elements.purchase_account",
  "bridge_element_phase.phase_code",
  "dim_category_gl.default_cost_center",
  "v_category_gl.account_code",
]);

/** How decision 25 resolves one mirrored value where the Playbook differs from canon. */
export function resolveValue(
  table: string,
  column: string,
  canon: string | null,
  playbook: string | null,
  importable: boolean,
): Resolution | undefined {
  const c = canon === null || canon.trim() === "" ? null : canon;
  const p = playbook === null || playbook.trim() === "" ? null : playbook;
  if (c === null && p !== null) {
    if (!importable) return undefined;
    return {
      outcome: "playbook-imported",
      basis: "bible-lacks-value",
      canon: p,
      note: "Owner decision 25: the Bible states no value, so the Playbook value is imported and marked as from the Playbook (xpms.playbook_sourced_value).",
    };
  }
  if (c !== null && p !== null && letters(c) === letters(p)) {
    return {
      outcome: "bible-kept",
      basis: "casing-or-punctuation",
      canon: c,
      note: "Owner decision 25: the labels differ only in casing or punctuation, so the Bible's label is kept.",
    };
  }
  const structural = STRUCTURE.has(`${table}.${column.split(":")[0] ?? column}`);
  return {
    outcome: "bible-kept",
    basis: structural ? "bible-label" : "bible-states-value",
    canon: c,
    note: structural
      ? "Owner decision 25: the Bible wins on structure (codes, states, labels and hierarchy), so the Bible's value is kept."
      : "Owner decision 25: the Bible states this value, so canon keeps it; only values the Bible lacks are imported from the Playbook.",
  };
}

export function playbookOnlyRow(
  d25: Decision25,
  sheet: string,
  key: string,
): Resolution | undefined {
  const e = d25.playbook_only_rows.find((r) => r.sheet === sheet && r.key === key);
  if (!e) return undefined;
  return {
    outcome: "mapped-to-existing",
    basis: "not-added",
    canon: e.canon_value,
    note: `Owner decision 25: the Bible wins on structure, so ${key} is not added to ${e.domain}; it resolves to the existing ${e.canon_value}. ${e.note}`,
  };
}

export function deferredEntry(d25: Decision25, sheet: string, key: string): Resolution | undefined {
  const e = d25.deferred.find((r) => r.sheet === sheet && r.key === key);
  if (!e) return undefined;
  return {
    outcome: "deferred",
    basis: "deferred",
    canon: null,
    note: `Not covered by owner decision 25; held for ${e.question} (finding A56-001). ${e.note}`,
  };
}

/**
 * A Standard Library label that is not in its canon vocabulary: a casing match follows the Bible, a
 * listed label maps to the closest existing value, a deferred one stays for the owner.
 */
export function libraryLabel(
  d25: Decision25,
  domain: string,
  label: string,
  key: string,
  vocabulary: ReadonlySet<string>,
): Resolution | undefined {
  const casing = [...vocabulary].find((v) => letters(v) === letters(label));
  if (casing !== undefined) {
    return {
      outcome: "mapped-to-existing",
      basis: "casing-or-punctuation",
      canon: casing,
      note: `Owner decision 25: ${domain} ${label} differs from canon ${casing} only in casing or punctuation, so it follows the Bible.`,
    };
  }
  const e = d25.library_labels.find((l) => l.domain === domain && l.label === label);
  if (e) {
    return {
      outcome: "mapped-to-existing",
      basis: e.basis,
      canon: e.canon_value,
      note: `Owner decision 25: ${domain} ${label} maps to the existing ${e.canon_domain} ${e.canon_value}; no ${e.canon_domain} is added. ${e.note}`,
    };
  }
  return deferredEntry(d25, "Enumerations", key);
}

/** xpms.label_mapping rows: every label decision 25 maps, from the library, the template and Playbook-only rows. */
export function labelMappingRows(
  d25: Decision25,
  libraryResolutions: readonly { domain: string; label: string; resolution: Resolution }[],
): SqlRow[] {
  const rows = new Map<string, SqlRow>();
  const put = (row: SqlRow) => {
    const key = `${String(row["source_list"])}|${String(row["playbook_label"])}`;
    if (rows.has(key)) throw new Error(`Decision 25 maps ${key} twice`);
    rows.set(key, row);
  };
  for (const l of libraryResolutions) {
    put({
      source_list: `Enumerations: ${l.domain}`,
      playbook_label: l.label,
      target_domain: targetDomain(d25, l.domain, l.label),
      canon_value: l.resolution.canon,
      basis: l.resolution.basis,
      decision: l.resolution.decision ?? d25.decision,
      note: l.resolution.note,
    });
  }
  for (const r of d25.playbook_only_rows) {
    put({
      source_list: r.sheet,
      playbook_label: r.key,
      target_domain: r.domain,
      canon_value: r.canon_value,
      basis: "not-added",
      decision: d25.decision,
      note: r.note,
    });
  }
  for (const t of d25.template_labels) {
    put({
      source_list: t.applies_to,
      playbook_label: t.label,
      target_domain: t.domain,
      canon_value: t.canon_value,
      basis: t.basis,
      decision: d25.decision,
      note: t.note ?? null,
    });
  }
  return [...rows.values()];
}

function targetDomain(d25: Decision25, domain: string, label: string): string {
  const listed = d25.library_labels.find((l) => l.domain === domain && l.label === label);
  if (listed) return listed.canon_domain;
  if (domain === "Workflow Status" || domain === "Payment Status") return "state";
  if (domain === "Unit of Measure") return "unit";
  if (domain === "Resource Kind") return "element_kind";
  return domain;
}

/** Canon vocabularies a decision 25 mapping may name, read from the generated canon tables. */
export function canonVocabulary(
  tables: ReadonlyMap<string, readonly SqlRow[]>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const col = (table: string, column: string) =>
    new Set((tables.get(table) ?? []).map((r) => String(r[column])));
  const enumLabels = (domain: string) =>
    new Set(
      (tables.get("std_enumeration") ?? [])
        .filter((e) => e["enum_domain"] === domain)
        .map((e) => String(e["enum_label"])),
    );
  return new Map<string, ReadonlySet<string>>([
    ["state", new Set([...col("dim_state", "state"), ...col("dim_record_state", "record_state")])],
    ["unit", col("dim_unit_alias", "alias")],
    ["element_kind", col("elements", "kind")],
    ["counterparty_type", col("dim_counterparty_type", "counterparty_type")],
    ["order_type", enumLabels("Order Type")],
    ["freight_type", enumLabels("Freight Type")],
    ["record_kind", col("dim_record_kind", "record_kind")],
    [
      "record_subtype",
      new Set(
        (tables.get("dim_record_subtype") ?? []).map(
          (r) => `${String(r["record_kind"])} · ${String(r["record_subtype"])}`,
        ),
      ),
    ],
    ["phase", col("dim_phase", "phase_code")],
    ["department", col("dim_department", "dept_code")],
    ["category", col("dim_category", "cat_urid")],
  ]);
}

/** Mappings that name a canon value canon does not hold. App lifecycle enums are checked by the field-target test. */
export function mappingProblems(
  rows: readonly SqlRow[],
  vocabulary: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    const domain = String(r["target_domain"]);
    const values = vocabulary.get(domain);
    if (values === undefined || r["canon_value"] === null) continue;
    if (!values.has(String(r["canon_value"])))
      problems.push(
        `Decision 25 maps ${String(r["source_list"])} ${String(r["playbook_label"])} to ${String(r["canon_value"])}, which is not a canon ${domain}`,
      );
  }
  return problems;
}

/** Entries of the decision file that no difference uses any more. */
export function staleEntries(
  d25: Decision25,
  used: {
    readonly rows: ReadonlySet<string>;
    readonly library: ReadonlySet<string>;
    readonly deferred: ReadonlySet<string>;
  },
): string[] {
  const out: string[] = [];
  for (const r of d25.playbook_only_rows)
    if (!used.rows.has(`${r.sheet}|${r.key}`))
      out.push(
        `Decision 25 entry no longer matches a difference: playbook_only_rows ${r.sheet} ${r.key}`,
      );
  for (const l of d25.library_labels)
    if (!used.library.has(`${l.domain}|${l.label}`))
      out.push(
        `Decision 25 entry no longer matches a difference: library_labels ${l.domain} ${l.label}`,
      );
  for (const d of d25.deferred)
    if (!used.deferred.has(`${d.sheet}|${d.key}`))
      out.push(`Decision 25 entry no longer matches a difference: deferred ${d.sheet} ${d.key}`);
  return out;
}

interface MapLike {
  readonly sheets: readonly {
    readonly sheet: string;
    readonly columns: readonly { readonly header: string }[];
  }[];
}

/** Sheet and column ordinal (1-based) of each "Sheet HEADER" an applies_to names. */
export function appliesTo(
  map: MapLike,
  appliesToText: string,
): { sheet: string; ordinal: number }[] {
  return appliesToText.split("; ").map((part) => {
    for (const s of map.sheets) {
      if (!part.startsWith(`${s.sheet} `)) continue;
      const header = part.slice(s.sheet.length + 1);
      const i = s.columns.findIndex((c) => c.header === header);
      if (i >= 0) return { sheet: s.sheet, ordinal: i + 1 };
    }
    throw new Error(`Decision 25 applies_to "${part}" names no Playbook column`);
  });
}

/**
 * Template label mappings must cover every label in the columns they name and name only labels those
 * columns hold. Counterparty columns also hold company names, so only their mapped labels are checked.
 */
export function templateLabelProblems(
  d25: Decision25,
  map: MapLike,
  tables: ReadonlyMap<string, readonly SqlRow[]>,
): string[] {
  const values = tables.get("production_template_values") ?? [];
  const labelsAt = (sheet: string, ordinal: number) =>
    values
      .filter((v) => v["sheet_name"] === sheet && v["column_ordinal"] === String(ordinal))
      .map((v) => String(v["value_text"]));
  const problems: string[] = [];
  const groups = new Map<string, TemplateLabel[]>();
  for (const t of d25.template_labels)
    groups.set(t.applies_to, [...(groups.get(t.applies_to) ?? []), t]);
  for (const [where, entries] of groups) {
    const observed = new Set<string>();
    for (const at of appliesTo(map, where))
      for (const v of labelsAt(at.sheet, at.ordinal)) observed.add(v);
    for (const e of entries)
      if (!observed.has(e.label))
        problems.push(
          `Decision 25 entry no longer matches a difference: template_labels ${where} ${e.label}`,
        );
    if (entries.some((e) => e.domain === "counterparty_type")) continue;
    for (const v of observed)
      if (!entries.some((e) => e.label === v))
        problems.push(`${where} holds "${v}", which decision 25 does not map`);
  }
  return problems;
}
