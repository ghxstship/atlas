import type { QuickAddResolution } from "@xos/ui/quick-add";

/**
 * Matching a quick add token (Section 11.7) against the things a person may name. The server action
 * builds the lists from what row level security lets the caller read, so nothing outside them can
 * ever be offered; this file only decides which of them a word means.
 */

/** One thing a token may name. */
export interface Named {
  readonly id: string;
  /** The name shown on the chip. */
  readonly label: string;
  /** Tells same-named things apart in a choice, such as the project of a scope. */
  readonly detail?: string;
  /** Codes matched whole, ignoring case: a URID, a scope code, a project key, a canon kind. */
  readonly codes?: readonly string[];
  /** Names matched as slugs: whole, by any word, or by their start. */
  readonly names: readonly string[];
}

/** Lowercase without accents, every run of other characters one hyphen: "Opening Night" is opening-night. */
export function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

const flat = (s: string) => s.replace(/-/g, "");

/** The most candidates an ambiguous token offers. */
export const CANDIDATE_LIMIT = 8;

/**
 * What a token's value names among the items, trying each rule in turn and stopping at the first
 * that matches anything: an exact code; a whole name ("dana-kim", "danakim"); any one word of a name
 * ("dana", "kim"); the start of a name ("open" for Opening Night Concert). One match resolves, more
 * than one offers a choice, none leaves the token as text.
 */
export function matchNamed(value: string, items: readonly Named[]): QuickAddResolution {
  const wanted = slug(value);
  if (wanted === "") return { status: "unresolved" };
  const code = value.toLocaleLowerCase("en-US");
  const slugs = new Map(items.map((i) => [i.id, i.names.map(slug).filter((s) => s !== "")]));
  const named = (i: Named) => slugs.get(i.id) ?? [];
  const rules: ((i: Named) => boolean)[] = [
    (i) => (i.codes ?? []).some((c) => c.toLocaleLowerCase("en-US") === code),
    (i) => named(i).some((s) => s === wanted || flat(s) === flat(wanted)),
    (i) => named(i).some((s) => s.split("-").includes(wanted)),
    (i) => named(i).some((s) => s.startsWith(wanted)),
  ];
  for (const rule of rules) {
    const hits = new Map<string, Named>();
    for (const item of items) if (rule(item) && !hits.has(item.id)) hits.set(item.id, item);
    const found = [...hits.values()];
    const only = found[0];
    if (found.length === 1 && only) {
      return {
        status: "resolved",
        id: only.id,
        label: only.label,
        ...(only.detail ? { detail: only.detail } : {}),
      };
    }
    if (found.length > 1) {
      return {
        status: "ambiguous",
        candidates: found.slice(0, CANDIDATE_LIMIT).map((i) => ({
          id: i.id,
          label: i.label,
          ...(i.detail ? { detail: i.detail } : {}),
        })),
      };
    }
  }
  return { status: "unresolved" };
}
