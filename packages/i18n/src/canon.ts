/**
 * Canon label translations (Section 15, ADR 0053): files to database.
 *
 * packages/i18n/canon/en-US/<vocabulary>.json holds each canon code's English label (written by the canon
 * importer); packages/i18n/canon/<locale>/<vocabulary>.json holds the translations, seeded from the app
 * catalogs for es-US and written by the Google Translate pipeline (the `canon` surface, ADR 0037). Migrations
 * load each locale's labels with `xpms.put_canon_labels`, and `xpms.canon_labels` reads them with an en-US
 * fallback. `pnpm --filter @xos/i18n canon:sql` prints the statements a new migration needs; the canon test
 * fails while the files and the migrations disagree, as the settings registry does.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CANON_DIR = "packages/i18n/canon";
export const CANON_SOURCE = "en-US";

/** A vocabulary's labels: code to label, or parent code to code to label (record subtypes). */
export type CanonLabels = { readonly [code: string]: string | { readonly [code: string]: string } };

/** Who wrote a locale's labels: the app catalogs, the Google Translate pipeline, or a person. */
export type Provenance = "catalog" | "machine" | "human";

/** Every locale's label files, by locale then vocabulary. */
export function readCanonLabels(root: string): Map<string, Map<string, CanonLabels>> {
  const out = new Map<string, Map<string, CanonLabels>>();
  const dir = join(root, CANON_DIR);
  if (!existsSync(dir)) return out;
  for (const locale of readdirSync(dir).sort()) {
    const files = readdirSync(join(dir, locale))
      .filter((f) => f.endsWith(".json"))
      .sort();
    const vocabularies = new Map<string, CanonLabels>();
    for (const file of files) {
      vocabularies.set(
        file.slice(0, -".json".length),
        JSON.parse(readFileSync(join(dir, locale, file), "utf8")) as CanonLabels,
      );
    }
    out.set(locale, vocabularies);
  }
  return out;
}

/** The labels as the database stores them: a subtype's code is `<kind>/<subtype>`. */
export function flattenLabels(labels: CanonLabels): Map<string, string> {
  const out = new Map<string, string>();
  for (const [code, value] of Object.entries(labels)) {
    if (typeof value === "string") out.set(code, value);
    else for (const [child, label] of Object.entries(value)) out.set(`${code}/${child}`, label);
  }
  return out;
}

/** A SQL string literal. */
function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The one statement that sets a locale's labels for a vocabulary, as migrations carry it. */
export function renderPutCanonLabels(
  vocabulary: string,
  locale: string,
  provenance: Provenance,
  labels: CanonLabels,
): string {
  return `select xpms.put_canon_labels(${lit(vocabulary)}, ${lit(locale)}, ${lit(provenance)}, ${lit(JSON.stringify(labels))}::jsonb);`;
}

const STATEMENT =
  /select xpms\.put_canon_labels\('((?:[^']|'')*)', '((?:[^']|'')*)', '(catalog|machine|human)', '((?:[^']|'')*)'::jsonb\);/g;

/** The latest labels each migration sets, by `<vocabulary>|<locale>`, in file order. */
export function definedCanonLabels(migrations: readonly string[]): Map<string, CanonLabels> {
  const out = new Map<string, CanonLabels>();
  const unquote = (s: string) => s.replaceAll("''", "'");
  for (const text of migrations) {
    for (const m of text.matchAll(STATEMENT)) {
      out.set(
        `${unquote(m[1] ?? "")}|${unquote(m[2] ?? "")}`,
        JSON.parse(unquote(m[4] ?? "{}")) as CanonLabels,
      );
    }
  }
  return out;
}

const sameLabels = (a: CanonLabels | undefined, b: CanonLabels | undefined) =>
  JSON.stringify([...flattenLabels(a ?? {})].sort()) ===
  JSON.stringify([...flattenLabels(b ?? {})].sort());

/** The translated (non-source) vocabularies whose files the migrations do not yet load. */
export function canonLabelDrift(
  files: ReadonlyMap<string, ReadonlyMap<string, CanonLabels>>,
  migrations: readonly string[],
): Array<{ vocabulary: string; locale: string; labels: CanonLabels }> {
  const defined = definedCanonLabels(migrations);
  const drift: Array<{ vocabulary: string; locale: string; labels: CanonLabels }> = [];
  for (const [locale, vocabularies] of files) {
    if (locale === CANON_SOURCE) continue;
    for (const [vocabulary, labels] of vocabularies) {
      if (Object.keys(labels).length === 0 && !defined.has(`${vocabulary}|${locale}`)) continue;
      if (!sameLabels(labels, defined.get(`${vocabulary}|${locale}`)))
        drift.push({ vocabulary, locale, labels });
    }
  }
  return drift;
}

/** Labels of a translated file whose code the en-US source does not have. */
export function unknownCodes(source: CanonLabels, labels: CanonLabels): string[] {
  const known = flattenLabels(source);
  return [...flattenLabels(labels).keys()].filter((code) => !known.has(code));
}
