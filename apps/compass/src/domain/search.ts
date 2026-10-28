/**
 * Search on Compass Today (Section 11.10 item 1, trace S11.10-02, A126, ADR 0086): shifts, tasks, records,
 * people, reference and actions, found in what the device already holds, so search works with no signal.
 * Nothing here reads the network; Today builds the documents from the offline store and this ranks them.
 *
 * The grammar is Atlas's command menu's (@xos/data/search-query): words, each also a prefix, "quoted
 * phrases" and -exclusions. The ranking follows A87 (ADR 0043) so results read alike in every shell:
 * a code typed in full (SOP-001, a radio channel, an incident number) ranks first; otherwise words in the
 * title count above words in the body, and that relevance is multiplied by a closeness factor with a
 * 45-day decay. Atlas decays on age; a field worker's next shift matters as much as their last, so the
 * distance from now counts either way.
 */
import { parseSearchQuery } from "@xos/data/search-query";

export const LOCAL_SEARCH_KINDS = [
  "shift",
  "task",
  "record",
  "person",
  "reference",
  "action",
] as const;
export type LocalSearchKind = (typeof LOCAL_SEARCH_KINDS)[number];

export interface LocalSearchDoc {
  readonly kind: LocalSearchKind;
  readonly id: string;
  readonly title: string;
  /** Searched below the title: a body, a project, a place. */
  readonly body?: string | null;
  /** A code or key that ranks first when typed in full: SOP-001, channel 4, an incident number. */
  readonly code?: string | null;
  /** Shown under the title (a day and time), not searched. */
  readonly subtitle?: string | null;
  /** When the item happens or last changed, ISO 8601; ranks the nearest first. */
  readonly at?: string | null;
  /** The Compass route that opens it. */
  readonly href: string;
}

export interface LocalSearchHit extends LocalSearchDoc {
  readonly score: number;
}

const DAY_MS = 86_400_000;

/** Lowercase without accents, so `Inspección` matches `inspeccion`. */
export function foldText(text: string): string {
  return text.toLocaleLowerCase("es-US").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** The words of a text: letters and digits, folded. */
export function words(text: string): string[] {
  return foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

/** How well one typed word matches a text's words: 1 for a whole word, 0.8 for a word's start, 0 for none. */
function wordMatch(typed: string, inText: readonly string[]): number {
  let best = 0;
  for (const w of inText) {
    if (w === typed) return 1;
    if (w.startsWith(typed)) best = 0.8;
  }
  return best;
}

/** The closeness factor: 1 at now, down to 0.7 far away (45-day decay), 1 when undated. */
export function closeness(at: string | null | undefined, now: number): number {
  if (!at) return 1;
  const when = Date.parse(at);
  if (Number.isNaN(when)) return 1;
  return 0.7 + 0.3 * Math.exp(-Math.abs(now - when) / DAY_MS / 45);
}

/**
 * The text relevance of one document for the parsed words, in [0, 1.5], or null when it does not match:
 * every word and phrase must appear, no excluded word or phrase may.
 */
export function relevance(
  doc: LocalSearchDoc,
  query: {
    readonly terms: readonly string[];
    readonly phrases: readonly string[];
    readonly excludeTerms: readonly string[];
    readonly excludePhrases: readonly string[];
  },
): number | null {
  const title = words(doc.title);
  const body = words([doc.body ?? "", doc.code ?? ""].join(" "));
  const all = [...title, ...body];
  const flat = ` ${all.join(" ")} `;
  const typed = query.terms.flatMap(words);
  const phrases = query.phrases.map((p) => words(p).join(" ")).filter((p) => p !== "");
  if (typed.length === 0 && phrases.length === 0) return null;
  if (query.excludeTerms.flatMap(words).some((w) => all.includes(w))) return null;
  if (
    query.excludePhrases
      .map((p) => words(p).join(" "))
      .some((p) => p !== "" && flat.includes(` ${p} `))
  ) {
    return null;
  }
  // A code typed in full ranks first, above any title.
  const code = doc.code ? words(doc.code).join(" ") : "";
  if (code !== "" && phrases.length === 0 && typed.join(" ") === code) return 1.5;
  let sum = 0;
  for (const w of typed) {
    const inTitle = wordMatch(w, title);
    const score = inTitle > 0 ? inTitle : wordMatch(w, body) * 0.4;
    if (score === 0) return null;
    sum += score;
  }
  const titleFlat = ` ${title.join(" ")} `;
  for (const p of phrases) {
    if (titleFlat.includes(` ${p} `)) sum += 1;
    else if (flat.includes(` ${p} `)) sum += 0.4;
    else return null;
  }
  const mean = sum / (typed.length + phrases.length);
  // A title that starts with what was typed reads as the thing asked for.
  const lead = [...phrases, typed.join(" ")].find((x) => x !== "") ?? "";
  const starts = lead !== "" && title.join(" ").startsWith(lead) ? 0.15 : 0;
  return Math.min(1, mean + starts);
}

/**
 * Finds the documents a query matches, best first: relevance times closeness, then the nearest, then the
 * title. At most `perKind` results of each kind (5 by default), as the command menus do.
 */
export function searchLocal(
  docs: readonly LocalSearchDoc[],
  input: string,
  options: { readonly now: number; readonly perKind?: number },
): LocalSearchHit[] {
  const parsed = parseSearchQuery(input.trim().slice(0, 200));
  const query = {
    terms: parsed.terms,
    phrases: parsed.phrases,
    excludeTerms: parsed.excludeTerms,
    excludePhrases: parsed.excludePhrases,
  };
  const scored: LocalSearchHit[] = [];
  for (const doc of docs) {
    const r = relevance(doc, query);
    if (r === null) continue;
    scored.push({ ...doc, score: r * closeness(doc.at, options.now) });
  }
  const distance = (d: LocalSearchDoc) => {
    const when = d.at ? Date.parse(d.at) : Number.NaN;
    return Number.isNaN(when) ? Number.POSITIVE_INFINITY : Math.abs(options.now - when);
  };
  scored.sort(
    (a, b) => b.score - a.score || distance(a) - distance(b) || a.title.localeCompare(b.title),
  );
  const perKind = options.perKind ?? 5;
  const taken = new Map<LocalSearchKind, number>();
  return scored.filter((hit) => {
    const n = taken.get(hit.kind) ?? 0;
    if (n >= perKind) return false;
    taken.set(hit.kind, n + 1);
    return true;
  });
}

/** Hits grouped by kind, in the order Today lists them, each group only when it has hits. */
export function groupHits(
  hits: readonly LocalSearchHit[],
): { readonly kind: LocalSearchKind; readonly hits: readonly LocalSearchHit[] }[] {
  return LOCAL_SEARCH_KINDS.flatMap((kind) => {
    const of = hits.filter((h) => h.kind === kind);
    return of.length > 0 ? [{ kind, hits: of }] : [];
  });
}

/**
 * The actions search reaches: a verb, the feature it needs (null for every person) and its route. Their
 * labels live under compassSearch.actions.
 */
export const COMPASS_SEARCH_ACTIONS = [
  { key: "reportIncident", feature: "incidents.report", href: "/incidents/new" },
  { key: "startInspection", feature: "inspections.perform", href: "/inspections" },
  { key: "scan", feature: null, href: "/scan" },
  { key: "addExpense", feature: "expenses.submit", href: "/expenses" },
  { key: "runOfShow", feature: "show.read", href: "/show" },
  { key: "openSchedule", feature: null, href: "/schedule" },
  { key: "openInbox", feature: null, href: "/inbox" },
  { key: "offlineQueue", feature: null, href: "/offline-queue" },
  { key: "reference", feature: null, href: "/reference" },
  { key: "help", feature: null, href: "/help" },
  { key: "settings", feature: null, href: "/settings" },
] as const;

export type CompassSearchAction = (typeof COMPASS_SEARCH_ACTIONS)[number];

/** The action documents for a person: those whose feature they have, labeled by `label`. */
export function actionDocs(
  allowed: (feature: Exclude<CompassSearchAction["feature"], null>) => boolean,
  label: (key: CompassSearchAction["key"]) => string,
): LocalSearchDoc[] {
  return COMPASS_SEARCH_ACTIONS.filter((a) => a.feature === null || allowed(a.feature)).map(
    (a) => ({
      kind: "action",
      id: a.key,
      title: label(a.key),
      href: a.href,
    }),
  );
}
