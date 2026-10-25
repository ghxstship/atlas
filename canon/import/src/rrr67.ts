import { readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * Owner decisions of 2026-10-24 on Linear RRR-67 (canon/rulings/rrr-67.yaml): the client of the CSMIA26 activation is
 * anonymized in every text value the importer writes, and the Standard Library SOPs and documents written from the
 * activation are generalized so every org receives them. A whole-value match is replaced first, then each substring
 * in the ruling's order, then, for a Standard Library value, each library substring. Migration 2001
 * (private.rrr67_anonymize and private.rrr67_generalize) applies the same tables to an existing database.
 */
type Pairs = readonly (readonly [string, string])[];

interface Ruling {
  readonly values: Readonly<Record<string, string>>;
  readonly replacements: Pairs;
  /** Applied only to the Standard Library SOPs and documents, after `replacements`. */
  readonly libraryReplacements: Pairs;
}

/** The canon tables, and the Playbook sheets they load from, that hold the Standard Library SOPs and documents. */
export const LIBRARY_TABLES = ["xpms.std_sop", "xpms.std_document_library"] as const;
export const LIBRARY_SHEETS = ["SOP Library", "Document & Asset Library"] as const;

/** Whether an importer location ("xpms.std_sop.title row 3") names a Standard Library SOP or document column. */
export function isLibraryLocation(location: string): boolean {
  return LIBRARY_TABLES.some((t) => location.startsWith(`${t}.`));
}

function pairs(list: unknown): Pairs {
  const out = (list ?? []) as [string, string][];
  for (const pair of out) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((s) => typeof s !== "string" || s === "")
    )
      throw new Error(
        `rrr-67.yaml: a replacement must be two non-empty strings, got ${JSON.stringify(pair)}`,
      );
  }
  return out;
}

export function parseRrr67(text: string): Ruling {
  const raw = parse(text) as {
    values?: Record<string, string>;
    replacements?: unknown;
    library_replacements?: unknown;
  };
  return {
    values: raw.values ?? {},
    replacements: pairs(raw.replacements),
    libraryReplacements: pairs(raw.library_replacements),
  };
}

const ruling = parseRrr67(
  readFileSync(new URL("../../rulings/rrr-67.yaml", import.meta.url), "utf8"),
);

/**
 * The value as the canon stores it once the client is anonymized; a Standard Library SOP or document value
 * (`library`) is generalized as well.
 */
export function anonymize(value: string, library = false, table: Ruling = ruling): string {
  const whole = table.values[value];
  if (whole !== undefined) return whole;
  let out = value;
  for (const [from, to] of table.replacements) out = out.split(from).join(to);
  if (library) for (const [from, to] of table.libraryReplacements) out = out.split(from).join(to);
  return out;
}
