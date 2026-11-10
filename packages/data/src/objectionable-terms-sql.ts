import type { ObjectionableTerm } from "./objectionable-terms.ts";

/**
 * The SQL that loads the objectionable language filter's terms into the database (migration 6890 and every later
 * sync), and the reading of it back, so the content filter test can hold the newest load to
 * src/objectionable-terms.ts. scripts/content-filter-migration.ts writes a migration with it.
 */

/** Marks the generated statement in a migration. */
export const LOAD_MARKER =
  "-- objectionable-terms: generated from packages/data/src/objectionable-terms.ts; do not edit by hand.";

const OPEN = "select private.load_objectionable_terms($terms$";
const CLOSE = "$terms$::jsonb);";

/** The statement that loads the terms, one term per line. */
export function objectionableTermsLoad(terms: readonly ObjectionableTerm[]): string {
  const rows = terms.map((t) => `  ${JSON.stringify({ term: t.term, language: t.language })}`);
  return `${LOAD_MARKER}\n${OPEN}[\n${rows.join(",\n")}\n]${CLOSE}\n`;
}

/** The terms a migration loads, or null when it loads none. */
export function readObjectionableTermsLoad(sql: string): ObjectionableTerm[] | null {
  const start = sql.lastIndexOf(OPEN);
  if (start < 0) return null;
  const end = sql.indexOf(CLOSE, start);
  if (end < 0) return null;
  const parsed: unknown = JSON.parse(sql.slice(start + OPEN.length, end));
  if (!Array.isArray(parsed)) return null;
  return parsed.map((row: { term: string; language: "en" | "es" }) => ({
    term: row.term,
    language: row.language,
  }));
}
