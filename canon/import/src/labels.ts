/**
 * Canon label sources for translation (Section 15: "Canon labels are translatable through xpms.dim_locale and
 * translation tables. Codes are never translated."; ADR 0053).
 *
 * For each translatable vocabulary this writes packages/i18n/canon/en-US/<vocabulary>.json, mapping each canon
 * code to its English label, from the same rows the seed migration carries. The Google Translate pipeline
 * (ADR 0037) reads these files as its `canon` surface and writes packages/i18n/canon/<locale>/; migrations load
 * the translations into xpms.canon_label (`pnpm --filter @xos/i18n canon:sql`), and xpms.canon_labels reads
 * them with an en-US fallback. A vocabulary whose code is two columns (record subtypes, keyed by their kind)
 * is written nested, parent then code.
 */
import type { GeneratedFile } from "./generate.ts";
import type { SqlRow } from "./sql.ts";

export interface LabelVocabulary {
  /** The vocabulary id: the file name and xpms.canon_vocabulary.vocabulary. */
  readonly id: string;
  /** The seeded table (the key of the importer's table map). */
  readonly table: string;
  readonly code: string;
  readonly label: string;
  /** For a two-column key, the column that scopes the code (record_kind for subtypes). */
  readonly parent?: string;
}

/** Every vocabulary whose labels people read, in xpms.canon_vocabulary order (migration 1541). */
export const LABEL_VOCABULARIES: readonly LabelVocabulary[] = [
  { id: "department", table: "dim_department", code: "dept_code", label: "department" },
  { id: "discipline", table: "dim_discipline", code: "disc_code", label: "discipline" },
  { id: "category", table: "dim_category", code: "cat_urid", label: "category" },
  { id: "phase", table: "dim_phase", code: "phase_code", label: "phase" },
  { id: "tier", table: "dim_tier", code: "tier_code", label: "tier" },
  { id: "team", table: "dim_team", code: "team_id", label: "team" },
  { id: "role", table: "dim_role", code: "role_code", label: "role" },
  { id: "jobTitle", table: "role", code: "role_code", label: "job_title" },
  { id: "recordKind", table: "dim_record_kind", code: "record_kind", label: "record_kind" },
  { id: "recordClass", table: "dim_record_class", code: "record_class", label: "record_class" },
  { id: "recordState", table: "dim_record_state", code: "record_state", label: "record_state" },
  {
    id: "recordSubtype",
    table: "dim_record_subtype",
    parent: "record_kind",
    code: "record_subtype",
    label: "record_subtype",
  },
  { id: "workerClassification", table: "worker_classification", code: "code", label: "label" },
  { id: "grade", table: "grade", code: "code", label: "label" },
  { id: "glAccount", table: "dim_gl_account", code: "account_code", label: "account_name" },
  { id: "emergencyCode", table: "emergency_code", code: "code", label: "label" },
  { id: "enumeration", table: "std_enumeration", code: "record_id", label: "enum_label" },
  { id: "region", table: "dim_region", code: "region_code", label: "name" },
  {
    id: "costCenter",
    table: "dim_cost_center_template",
    code: "cost_center_id",
    label: "cost_center",
  },
  {
    id: "counterpartyType",
    table: "dim_counterparty_type",
    code: "counterparty_type",
    label: "counterparty_type",
  },
];

export const LABELS_DIR = "packages/i18n/canon/en-US";

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function text(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** One vocabulary's code to label map (nested by parent for a two-column key), codes in byte order. */
export function vocabularyLabels(
  vocabulary: LabelVocabulary,
  rows: readonly SqlRow[],
): Record<string, string | Record<string, string>> {
  const out: Record<string, string | Record<string, string>> = {};
  const sorted = [...rows].sort((a, b) =>
    byteOrder(
      `${vocabulary.parent ? (text(a, vocabulary.parent) ?? "") : ""}\u0000${text(a, vocabulary.code) ?? ""}`,
      `${vocabulary.parent ? (text(b, vocabulary.parent) ?? "") : ""}\u0000${text(b, vocabulary.code) ?? ""}`,
    ),
  );
  for (const row of sorted) {
    const code = text(row, vocabulary.code);
    const label = text(row, vocabulary.label);
    if (code === null || label === null) continue;
    if (vocabulary.parent) {
      const parent = text(row, vocabulary.parent);
      if (parent === null) continue;
      const group = (out[parent] ??= {});
      if (typeof group === "object") group[code] = label;
    } else {
      out[code] = label;
    }
  }
  return out;
}

/** The committed en-US label files, one per vocabulary. */
export function labelFiles(tables: ReadonlyMap<string, readonly SqlRow[]>): GeneratedFile[] {
  return LABEL_VOCABULARIES.map((vocabulary) => {
    const rows = tables.get(vocabulary.table);
    if (!rows) throw new Error(`Canon labels: the importer has no table ${vocabulary.table}.`);
    return {
      path: `${LABELS_DIR}/${vocabulary.id}.json`,
      content: `${JSON.stringify(vocabularyLabels(vocabulary, rows), null, 2)}\n`,
      committed: true,
    };
  });
}
