/**
 * How a contract and rider intake sorts what it read by act (B15, parity gap G-177), the way P3's
 * import review sorts duplicates. Deterministic code, never the model, with no zod and no model
 * code, so the Atlas panel can import it. Party candidates come from the database
 * (app.intake_party_candidates); this only groups the files.
 */

/**
 * An act's name as the grouping compares it: NFKD with accents removed, case-folded, a leading
 * "the" dropped, "f/s/o" and everything after it dropped, a "(DJ set)" or "(live)" dropped, and
 * punctuation collapsed to single spaces.
 */
export function normalizeAct(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\bf\s*\/\s*s\s*\/\s*o\b.*$/, "")
    .replace(/\((?:dj\s*set|live)\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the\s+/, "")
    .trim();
}

/** Trigrams of a text as pg_trgm reads it: each word padded with two spaces before and one after. */
function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.split(/[^a-z0-9]+/).filter((w) => w.length > 0)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** Trigram similarity, as extensions.similarity computes it: shared trigrams over all of them. */
export function trigramSimilarity(a: string, b: string): number {
  const x = trigrams(a.toLowerCase());
  const y = trigrams(b.toLowerCase());
  if (x.size === 0 && y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/** The similarity at or above which two act names are one act, P3's duplicate threshold. */
export const ACT_SIMILARITY = 0.85;

export interface ActGroup<T> {
  /** The normalized act name the group is keyed by. */
  readonly act: string;
  /** The first name as read, for display. */
  readonly label: string;
  readonly items: readonly T[];
}

/**
 * Groups items by act: a normalized name joins the first group whose key it matches with a trigram
 * similarity of ACT_SIMILARITY or more, or starts a new group. Items without a name are grouped
 * under an empty act. Groups come in act order, items in their given order.
 */
export function groupByAct<T>(
  items: readonly T[],
  nameOf: (item: T) => string | null,
): ActGroup<T>[] {
  const groups: { act: string; label: string; items: T[] }[] = [];
  for (const item of items) {
    const name = nameOf(item) ?? "";
    const act = normalizeAct(name);
    const group = groups.find((g) =>
      act === "" || g.act === ""
        ? g.act === act
        : g.act === act || trigramSimilarity(g.act, act) >= ACT_SIMILARITY,
    );
    if (group) group.items.push(item);
    else groups.push({ act, label: name.trim(), items: [item] });
  }
  return groups.sort((a, b) => a.act.localeCompare(b.act));
}
