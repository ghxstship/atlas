import { embedTexts, vectorLiteral, type EmbeddingProvider } from "@xos/ai/embeddings";
import { fillRoute, getNode, isNodeVisible, type NavContext, type Sitemap } from "@xos/ia";
import { normalizeState } from "@xos/data/search-query";
import type { SettingDefinition } from "@xos/schemas/settings";

/**
 * The command menu's server-side index (Section 11.10 item 1, Section 11.11 Settings "any setting reached
 * in 1 search"; findings A59-015 and A65-005): pure helpers the search action composes, kept apart so tests
 * reach them without a request. Nothing here ships to the browser.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The 26 canon record kinds (Bible tab 24), whose labels live under work.kinds. */
export const RECORD_KINDS = [
  "Approval",
  "Booking",
  "Build",
  "Compliance",
  "Contract",
  "Deadline",
  "Decision",
  "Distribution",
  "Document",
  "Event",
  "Goal",
  "Inspection",
  "Meeting",
  "Milestone",
  "Payment",
  "Permit",
  "Recruitment",
  "Rehearsal",
  "Report",
  "Risk",
  "Shift",
  "Strike",
  "Supply",
  "Task",
  "Timeline",
  "Training",
] as const;

/** The nine record states (work.states) and the four incident states (incidents.states). */
export const RECORD_STATES = [
  "Proposed",
  "Ready",
  "Scheduled",
  "Active",
  "Blocked",
  "In Review",
  "Complete",
  "Deferred",
  "Canceled",
] as const;
export const INCIDENT_STATES = ["Reported", "Dispatched", "Contained", "Closed"] as const;

function lower(text: string): string {
  return text.toLocaleLowerCase("es-US").trim();
}

/** True when every word appears in the text, ignoring case and accents. */
export function matchesWords(text: string, words: readonly string[]): boolean {
  const fold = (s: string) => lower(s).normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const haystack = fold(text);
  return words.every((word) => haystack.includes(fold(word)));
}

/**
 * Typed record kinds as canon kinds: `task`, `Tarea` (the Spanish label) and `perm` (the start of a
 * label, three letters or more) all name a kind. A value that names none passes through unchanged, so
 * the database matches it as typed and finds nothing rather than everything.
 */
export function resolveKinds(values: readonly string[], t: Translate): string[] {
  return values.map((value) => {
    const v = lower(value);
    const found =
      RECORD_KINDS.find((k) => lower(k) === v || lower(t(`work.kinds.${k}`)) === v) ??
      (v.length >= 3
        ? RECORD_KINDS.find(
            (k) => lower(k).startsWith(v) || lower(t(`work.kinds.${k}`)).startsWith(v),
          )
        : undefined);
    return found ?? value;
  });
}

/** Typed states as the normalized canon states the database compares (`enrevisión` to `inreview`). */
export function resolveStatuses(values: readonly string[], t: Translate): string[] {
  return values.map((value) => {
    if (value === "open" || value === "closed") return value;
    const record = RECORD_STATES.find(
      (s) => normalizeState(s) === value || normalizeState(t(`work.states.${s}`)) === value,
    );
    if (record) return normalizeState(record);
    const incident = INCIDENT_STATES.find(
      (s) => normalizeState(s) === value || normalizeState(t(`incidents.states.${s}`)) === value,
    );
    return incident ? normalizeState(incident) : value;
  });
}

export interface SettingEntry {
  readonly key: string;
  /** The setting's label, then the page it is on: `Time zone · Localization`. */
  readonly label: string;
  readonly href: string;
  readonly icon: "Settings" | "UserRound";
}

/**
 * Settings whose label, key or page match every word, on the settings pages the viewer can open:
 * the org page for org settings and the personal page for personal ones. Each link opens the page with
 * `?setting=<key>`, which focuses the field (Section 11.11: any setting reached in 1 search).
 */
export function settingEntries(input: {
  readonly settings: readonly SettingDefinition[];
  readonly words: readonly string[];
  readonly sitemap: Sitemap;
  readonly nav: NavContext;
  readonly params: Readonly<Record<string, string>>;
  readonly t: Translate;
  readonly limit?: number;
}): SettingEntry[] {
  const { settings, words, sitemap, nav, params, t } = input;
  if (words.length === 0) return [];
  const out: SettingEntry[] = [];
  for (const setting of settings) {
    if (setting.hidden) continue;
    for (const group of ["org", "personal"] as const) {
      const pageId = setting.pages[group];
      if (!pageId || !isNodeVisible(sitemap, pageId, nav)) continue;
      const page = getNode(sitemap, pageId).node;
      if (page.route === undefined) continue;
      const label = t(setting.label);
      const pageLabel = t(page.label);
      // The label, the key and the page; not the help text, whose every word would match too much.
      const haystack = [label, setting.key.replace(/[._]/g, " "), pageLabel].join(" ");
      if (!matchesWords(haystack, words)) continue;
      out.push({
        key: setting.key,
        label: `${label} · ${pageLabel}`,
        href: `${fillRoute(page.route, params)}?setting=${encodeURIComponent(setting.key)}`,
        icon: group === "org" ? "Settings" : "UserRound",
      });
    }
  }
  // Labels that start with the first word first, then registry order.
  const first = lower(words[0] ?? "");
  return out
    .map((entry, index) => ({ entry, index, starts: lower(entry.label).startsWith(first) ? 0 : 1 }))
    .sort((a, b) => a.starts - b.starts || a.index - b.index)
    .slice(0, input.limit ?? 6)
    .map((x) => x.entry);
}

export interface QueryVector {
  /** pgvector's text form, for app.global_search's p_embedding. */
  readonly literal: string;
  readonly model: string;
  readonly minSimilarity: number;
}

/**
 * The vector of the words a person searched with, for the semantic half of the search, or null. Nothing is
 * embedded unless a provider runs (Supabase's gte-small by default; XOS_SEARCH_EMBEDDINGS=off turns it off)
 * AND the org has search.semantic_enabled on, which `semanticEnabled` reads from app.search_context only
 * when a provider exists. The text is redacted by `embedTexts`; a provider slower than the time limit, or
 * failing, leaves the search lexical.
 */
export async function queryVector(input: {
  readonly provider: EmbeddingProvider | null;
  readonly text: string;
  readonly semanticEnabled: () => Promise<boolean>;
  readonly timeoutMs?: number;
}): Promise<QueryVector | null> {
  const { provider } = input;
  const text = input.text.trim();
  if (!provider || text.length < 3) return null;
  if (!(await input.semanticEnabled())) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), input.timeoutMs ?? 1500);
  });
  try {
    const vectors = await Promise.race([embedTexts(provider, [text], "query"), timeout]);
    const vector = vectors?.[0];
    if (!vector) return null;
    return {
      literal: vectorLiteral(vector),
      model: provider.model,
      minSimilarity: provider.minSimilarity,
    };
  } catch (error) {
    console.error("Search embedding failed; searching by words only", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
