import * as en from "chrono-node/en";
import * as es from "chrono-node/es";
import {
  addDays,
  quickAddKey,
  tidyTitle,
  wallClockAt,
  zoneOffsetMinutes,
  type QuickAddParse,
  type QuickAddSpan,
  type QuickAddTokenType,
} from "./quickAddCore.ts";

export interface QuickAddOptions {
  /** The moment relative phrases count from ("tomorrow", "next Friday"); now by default. */
  referenceDate?: Date;
  /** The language of the date phrases: Spanish for `es-*` (chrono's Spanish parser), English otherwise. */
  locale?: string;
  /** The IANA zone whose calendar and clock the phrases are read on; the device's by default. */
  timeZone?: string;
  /** Keys (`quickAddKey`) of tokens the person turned back into text. */
  dismissed?: readonly string[];
}

const ICONS: Readonly<Record<QuickAddTokenType, string>> = {
  person: "User",
  tag: "Hash",
  kind: "Shapes",
  scope: "MapPin",
  date: "Calendar",
};

const SIGIL_TYPES: Readonly<Record<string, QuickAddTokenType>> = {
  "@": "person",
  "#": "tag",
  "/": "kind",
  "~": "scope",
};

// A token starts the line or follows white space, so dana@example.com, and/or and w/crew stay text.
const TOKEN = /(^|\s)([@#/~])([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu;
const URID = /^\d{4}\.\d{2}\.\d{2}$/;

/** Whether a sigil's text names something of its type: people, tags and kinds start with a letter. */
function accepts(type: QuickAddTokenType, body: string): boolean {
  if (body === "") return false;
  if (type === "tag") return /^\p{L}/u.test(body) || URID.test(body);
  if (type === "kind") return /^\p{L}[\p{L}-]*$/u.test(body);
  if (type === "person") return /^\p{L}/u.test(body);
  return true;
}

// Short words chrono reads as days or months that are ordinary words too ("Sun stage wash",
// "sat down", "limpiar mar"): alone they stay text; "Sun 8am" or "mar 3" still parse.
const AMBIGUOUS: Readonly<Record<"en" | "es", ReadonlySet<string>>> = {
  en: new Set([
    ...["sun", "sat", "wed", "mar", "jan", "april", "may", "june", "august"],
    ...["morning", "afternoon", "evening", "night"],
  ]),
  es: new Set(["mar", "dom", "sol", "mayo"]),
};

// The word just before a date that only joins it to the title ("Hang truss by Friday", "el viernes").
const CONNECTORS: Readonly<Record<"en" | "es", ReadonlySet<string>>> = {
  en: new Set(["at", "on", "by", "due", "for", "from"]),
  es: new Set(["el", "la", "a", "al", "para", "de", "del", "en", "desde"]),
};

// Phrases chrono stops short of: it reads only the last word, a day early.
const DAY_AFTER: Readonly<Record<"en" | "es", RegExp>> = {
  en: /\bday after\s+$/i,
  es: /(^|\s)pasado\s+$/i,
};

interface DatePart {
  iso: string;
  time?: string;
}

interface ChronoComponents {
  get(component: "year" | "month" | "day" | "hour" | "minute"): number | null;
  isCertain(component: "hour" | "timezoneOffset"): boolean;
  date(): Date;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The day, and the time when one was named, on the zone's calendar. */
function datePart(c: ChronoComponents, zone: string): DatePart {
  if (c.isCertain("timezoneOffset")) {
    // "9pm EST" names its own zone: read the instant on the line's zone instead.
    const w = wallClockAt(c.date(), zone);
    return { iso: `${w.y}-${pad(w.m)}-${pad(w.d)}`, time: `${pad(w.h)}:${pad(w.mi)}` };
  }
  const iso = `${c.get("year")}-${pad(c.get("month") ?? 1)}-${pad(c.get("day") ?? 1)}`;
  return c.isCertain("hour")
    ? { iso, time: `${pad(c.get("hour") ?? 0)}:${pad(c.get("minute") ?? 0)}` }
    : { iso };
}

/** A numeric date written in the other locale's order (24/10 in English, 10/24 in Spanish), or 24/7. */
function wrongOrder(text: string, lang: "en" | "es"): boolean {
  if (/^24\s*\/\s*7$/.test(text)) return true;
  const numeric = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?$/.exec(text);
  if (!numeric) return false;
  const [first, second] = [Number(numeric[1]), Number(numeric[2])];
  return lang === "en" ? first > 12 : second > 12;
}

function blank(text: string, index: number, length: number): string {
  return text.slice(0, index) + " ".repeat(length) + text.slice(index + length);
}

/**
 * Parses @person, #tag, /kind and ~scope tokens, then a date phrase with chrono-node ("tomorrow at
 * 3pm", "next Friday", "viernes 8am"), read in the given language on the given zone's calendar. What
 * remains is the title. A line sets one of each: a second person, tag, kind, scope or date stays in
 * the title as typed, as does any token the person dismissed.
 */
export function parseQuickAdd(text: string, options: Date | QuickAddOptions = {}): QuickAddParse {
  const opts: QuickAddOptions = options instanceof Date ? { referenceDate: options } : options;
  const reference = opts.referenceDate ?? new Date();
  const zone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lang: "en" | "es" = opts.locale?.toLowerCase().startsWith("es") ? "es" : "en";
  const dismissed = new Set(opts.dismissed ?? []);
  const tokens: QuickAddSpan[] = [];
  const taken = new Set<QuickAddTokenType>();
  // Every token's text is hidden from chrono, so ~friday is a scope and never a date.
  let masked = text;
  for (const match of text.matchAll(TOKEN)) {
    const type = SIGIL_TYPES[match[2] ?? ""];
    const body = (match[3] ?? "").replace(/[._-]+$/u, "");
    if (type === undefined || !accepts(type, body)) continue;
    const index = (match.index ?? 0) + (match[1] ?? "").length;
    masked = blank(masked, index, body.length + 1);
    const token = { type, value: body, icon: ICONS[type] };
    if (taken.has(type) || dismissed.has(quickAddKey(token))) continue;
    taken.add(type);
    tokens.push({ ...token, index, length: body.length + 1 });
  }

  const chrono = lang === "es" ? es.casual : en.casual;
  const at = { instant: reference, timezone: zoneOffsetMinutes(reference, zone) };
  for (const result of chrono.parse(masked, at, { forwardDate: true })) {
    let index = result.index;
    let phrase = result.text;
    let start = datePart(result.start, zone);
    const before = DAY_AFTER[lang].exec(masked.slice(0, index));
    if (before && /^(tomorrow|mañana)\b/i.test(phrase)) {
      const extra = before[0].trimStart();
      index -= extra.length;
      phrase = text.slice(index, result.index + result.text.length);
      start = { ...start, iso: addDays(start.iso, 1) };
    }
    if (wrongOrder(phrase.trim(), lang)) continue;
    if (AMBIGUOUS[lang].has(phrase.trim().toLocaleLowerCase("en-US"))) continue;
    const token = { type: "date" as const, value: phrase, icon: ICONS.date };
    if (dismissed.has(quickAddKey(token))) continue;
    const end = result.end ? datePart(result.end, zone) : null;
    if (end && start.time && end.time && `${end.iso}T${end.time}` <= `${start.iso}T${start.time}`) {
      // "10pm-6am" ends the next morning.
      end.iso = addDays(start.iso, 1);
    }
    const lead = /(\S+)\s+$/u.exec(text.slice(0, index));
    const connector = lead?.[1] && CONNECTORS[lang].has(lead[1].toLocaleLowerCase("en-US"));
    const cut = connector && lead ? index - lead[0].length : index;
    tokens.push({
      ...token,
      iso: start.iso,
      ...(start.time ? { time: start.time } : {}),
      ...(end ? { endIso: end.iso } : {}),
      ...(end?.time ? { endTime: end.time } : {}),
      index: cut,
      length: index + phrase.length - cut,
    });
    break;
  }

  tokens.sort((a, b) => a.index - b.index);
  let title = text;
  for (const t of [...tokens].reverse()) {
    title = `${title.slice(0, t.index)} ${title.slice(t.index + t.length)}`;
  }
  return { text, title: tidyTitle(title), tokens };
}
