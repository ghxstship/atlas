/**
 * The parts of quick add (Section 11.7) that run anywhere, servers included: the token and result
 * shapes, the key a resolution is filed under, folding the tokens an app could not resolve back into
 * the title, and reading a wall-clock time in an IANA zone. `parseQuickAdd` (chrono-node) is the
 * browser half; `@xos/ui/quick-add` exports only this file, so a server action never loads chrono.
 */

export type QuickAddTokenType = "person" | "tag" | "kind" | "scope" | "date";

export interface QuickAddToken {
  type: QuickAddTokenType;
  /** The value without its sigil (`dana` for `@dana`); for a date, the phrase as typed. */
  value: string;
  icon: string;
  /** For dates: the day as an ISO date, on the calendar of the zone the line was parsed in. */
  iso?: string;
  /** For dates that name a time of day: the time as HH:MM, 24-hour. */
  time?: string;
  /** For a range such as "Friday 8am-4pm": the day it ends. */
  endIso?: string;
  /** For a range that names its end time: the time as HH:MM, 24-hour. */
  endTime?: string;
  /** For a token the app resolved: the id of the person, tag, kind or scope it names. */
  id?: string;
  /** For a token the app resolved: the name to show. */
  label?: string;
}

/** A token with where it sits in the typed line, so it can be cut out or left in place. */
export interface QuickAddSpan extends QuickAddToken {
  /** Offset of the text the token removes from the title, its leading "by" or "el" included. */
  index: number;
  length: number;
}

export interface QuickAddResult {
  /** The line without the tokens it set; tokens nothing resolved stay in it as typed. */
  title: string;
  tokens: QuickAddToken[];
}

/** What `parseQuickAdd` reads from a line, before any token is resolved. */
export interface QuickAddParse extends QuickAddResult {
  text: string;
  tokens: QuickAddSpan[];
}

export interface QuickAddCandidate {
  id: string;
  label: string;
  /** Tells candidates with the same name apart, for example the project a scope belongs to. */
  detail?: string;
}

/** How an app resolved one token: to one thing, to several it cannot choose between, or to nothing. */
export type QuickAddResolution =
  | { status: "resolved"; id: string; label: string; detail?: string }
  | { status: "ambiguous"; candidates: QuickAddCandidate[] }
  | { status: "unresolved" };

/**
 * Resolves people, tags, kinds and scopes against what the person may see, keyed by `quickAddKey`.
 * A key the answer leaves out counts as unresolved.
 */
export type QuickAddResolver = (
  tokens: readonly QuickAddToken[],
) => Promise<Readonly<Record<string, QuickAddResolution>>>;

const SIGILS: Readonly<Record<Exclude<QuickAddTokenType, "date">, string>> = {
  person: "@",
  tag: "#",
  kind: "/",
  scope: "~",
};

/** The sigil a token is typed with; dates have none. */
export function quickAddSigil(type: QuickAddTokenType): string {
  return type === "date" ? "" : SIGILS[type];
}

/** The key a token's resolution is filed under: its type and value, case and accents as typed folded. */
export function quickAddKey(token: Pick<QuickAddToken, "type" | "value">): string {
  return `${token.type}:${token.value.normalize("NFC").toLocaleLowerCase("en-US")}`;
}

/** A token without its place in the line. */
function tokenOf(span: QuickAddSpan): QuickAddToken {
  return Object.fromEntries(
    Object.entries(span).filter(([key]) => key !== "index" && key !== "length"),
  ) as unknown as QuickAddToken;
}

/** One space between words, none before punctuation a removed token left behind. */
export function tidyTitle(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[,.;:!?]\s*/, "")
    .trim();
}

/**
 * The line a person typed as the app should save it. Dates always apply. Without resolutions every
 * token applies; with them, a token applies when it resolved or the person chose one of its
 * candidates, and any other token stays in the title exactly where it was typed.
 */
export function finalizeQuickAdd(
  parse: QuickAddParse,
  resolutions?: Readonly<Record<string, QuickAddResolution>>,
  choices: Readonly<Record<string, string>> = {},
): QuickAddResult {
  const applied: { span: QuickAddSpan; token: QuickAddToken }[] = [];
  for (const span of parse.tokens) {
    const token = tokenOf(span);
    if (token.type === "date" || resolutions === undefined) {
      applied.push({ span, token });
      continue;
    }
    const key = quickAddKey(token);
    const resolution = resolutions[key];
    if (resolution?.status === "resolved") {
      applied.push({ span, token: { ...token, id: resolution.id, label: resolution.label } });
    } else if (resolution?.status === "ambiguous") {
      const chosen = resolution.candidates.find((c) => c.id === choices[key]);
      if (chosen) applied.push({ span, token: { ...token, id: chosen.id, label: chosen.label } });
    }
  }
  let title = parse.text;
  for (const { span } of [...applied].sort((a, b) => b.span.index - a.span.index)) {
    title = `${title.slice(0, span.index)} ${title.slice(span.index + span.length)}`;
  }
  return {
    title: tidyTitle(title),
    tokens: applied.sort((a, b) => a.span.index - b.span.index).map((a) => a.token),
  };
}

interface WallClock {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
}

const wallFormats = new Map<string, Intl.DateTimeFormat>();

/** The wall clock in a zone at an instant. */
export function wallClockAt(at: Date | number, zone: string): WallClock {
  let format = wallFormats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    wallFormats.set(zone, format);
  }
  const parts = format.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute") };
}

/** Minutes the zone runs ahead of UTC at an instant (-240 for New York in summer). */
export function zoneOffsetMinutes(at: Date | number, zone: string): number {
  const ms = typeof at === "number" ? at : at.getTime();
  const w = wallClockAt(ms, zone);
  return Math.round(
    (Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - Math.floor(ms / 60_000) * 60_000) / 60_000,
  );
}

/**
 * The instant a wall-clock day and time name in a zone, as ISO. A time skipped by a daylight saving
 * change reads as the same time after the change (2:30 on the spring-forward night is 3:30), and a
 * time the fall-back night repeats reads as its first occurrence.
 */
export function zonedInstant(day: string, time: string, zone: string): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const [h = 0, mi = 0] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - zoneOffsetMinutes(guess, zone) * 60_000;
  const second = guess - zoneOffsetMinutes(first, zone) * 60_000;
  const wall = wallClockAt(second, zone);
  return new Date(wall.h === h && wall.mi === mi ? second : first).toISOString();
}

/** A calendar day moved by whole days, as an ISO date. */
export function addDays(day: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
