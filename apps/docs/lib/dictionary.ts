/**
 * The data dictionary for the docs pages, read at build time from content/data-dictionary.json, which
 * scripts/generate-data-dictionary.ts writes from the catalog comments (Sections 3.15 and 7.1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./content.ts";
import { tableSlug, type DataDictionary, type DictionaryTable } from "./dictionary-source.ts";

export {
  tableSlug,
  type DataDictionary,
  type DictionaryColumn,
  type DictionaryTable,
} from "./dictionary-source.ts";

/** The schemas in reading order, with what each holds. */
export const DICTIONARY_SCHEMAS = ["app", "xpms", "api_external", "api_public"] as const;

let cached: DataDictionary | undefined;

export function loadDictionary(): DataDictionary {
  cached ??= JSON.parse(
    readFileSync(join(APP_DIR, "content", "data-dictionary.json"), "utf8"),
  ) as DataDictionary;
  return cached;
}

export function findTable(slug: string): DictionaryTable | undefined {
  return loadDictionary().tables.find((t) => tableSlug(t) === slug);
}

/** The first sentence of a comment, for the index. */
export function firstSentence(comment: string | null): string {
  if (comment === null) return "";
  const match = /^(.+?[.!?])(\s|$)/.exec(comment.trim());
  return match?.[1] ?? comment.trim();
}
