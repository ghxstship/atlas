import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Canon labels in a locale (Section 15: "Canon labels are translatable through xpms.dim_locale and translation
 * tables. Codes are never translated."; ADR 0053). The one reader of xpms.canon_labels (migration 1541): every
 * code of a vocabulary with its label in the locale, or the canon table's en-US label where there is no
 * translation, so a label is never missing and a code never stands in for one.
 */

/** The translatable canon vocabularies (xpms.canon_vocabulary). */
export const CANON_VOCABULARIES = [
  "department",
  "discipline",
  "category",
  "phase",
  "tier",
  "team",
  "role",
  "jobTitle",
  "recordKind",
  "recordClass",
  "recordState",
  "recordSubtype",
  "workerClassification",
  "grade",
  "glAccount",
  "emergencyCode",
  "enumeration",
  "region",
  "costCenter",
  "counterpartyType",
] as const;
export type CanonVocabulary = (typeof CANON_VOCABULARIES)[number];

/** A vocabulary's labels by code in a locale (a record subtype's code is `<kind>/<subtype>`). */
export async function listCanonLabels(
  db: XosClient,
  vocabulary: CanonVocabulary,
  locale: string,
): Promise<Result<Map<string, string>>> {
  const { data, error } = await db
    .schema("xpms")
    .rpc("canon_labels", { p_vocabulary: vocabulary, p_locale: locale });
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as ReadonlyArray<{ code: string | null; label: string | null }>;
  return ok(
    new Map(
      rows.flatMap((r) =>
        r.code !== null && r.label !== null ? [[r.code, r.label] as const] : [],
      ),
    ),
  );
}

/**
 * Rows with their label replaced by the locale's (`apply` puts it in place). A row whose code has no label
 * keeps the English it was read with, so a failed or partial lookup still never shows a code.
 */
export function withCanonLabels<T>(
  rows: readonly T[],
  labels: ReadonlyMap<string, string>,
  code: (row: T) => string,
  apply: (row: T, label: string) => T,
): T[] {
  return rows.map((row) => {
    const label = labels.get(code(row));
    return label === undefined ? row : apply(row, label);
  });
}
