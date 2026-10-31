/**
 * Time shorthand for the schedule grid (B4, G-41): what a planner types into a Time or Duration cell, read without
 * chrono so a server and a browser read it the same way. `@xos/ui/quick-add` re-exports this file.
 *
 *   en  8, 8a, 8am, 830p, 8:30 pm, 20:30, noon, midnight; ranges 8a-5p, 8-11:30p (the end's meridiem carries back to
 *       the start when that keeps the start first), 9 to 5
 *   es  8 a. m., 8:30 p. m., 20 h, mediodía, medianoche; ranges 8 a 10, 9 hasta 17
 *
 * An end at or before the start rolls to the next day (endDayOffset 1), so 22-2 runs past midnight. Times come back
 * as 24-hour HH:MM on the wall clock; the grid reads them in the project's zone.
 */

export interface TimeShorthand {
  /** Start as HH:MM, 24-hour. */
  readonly start: string;
  /** End as HH:MM, 24-hour; null for a single time. */
  readonly end: string | null;
  /** 1 when the end falls on the next day. */
  readonly endDayOffset: 0 | 1;
}

export interface TimeShorthandOptions {
  /** en-US or es-US; both languages' words are read either way, the locale only breaks ties. */
  readonly locale?: string;
}

type Meridiem = "a" | "p" | "h" | null;

interface Clock {
  readonly h: number;
  readonly m: number;
  readonly meridiem: Meridiem;
}

const WORDS: Readonly<Record<string, Clock>> = {
  noon: { h: 12, m: 0, meridiem: "h" },
  midday: { h: 12, m: 0, meridiem: "h" },
  midnight: { h: 0, m: 0, meridiem: "h" },
  mediodía: { h: 12, m: 0, meridiem: "h" },
  mediodia: { h: 12, m: 0, meridiem: "h" },
  medianoche: { h: 0, m: 0, meridiem: "h" },
};

const ONE =
  /^(\d{1,4})(?:[:.h](\d{2}))?\s*(a|am|a\.m\.|a\.\s?m\.|p|pm|p\.m\.|p\.\s?m\.|h|hrs|horas)?$/u;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readOne(raw: string): Clock | null {
  const text = normalize(raw);
  const word = WORDS[text];
  if (word) return word;
  const match = ONE.exec(text);
  if (!match) return null;
  const digits = match[1] ?? "";
  let h: number;
  let m: number;
  if (match[2] !== undefined) {
    h = Number(digits);
    m = Number(match[2]);
  } else if (digits.length >= 3) {
    h = Number(digits.slice(0, -2));
    m = Number(digits.slice(-2));
  } else {
    h = Number(digits);
    m = 0;
  }
  const suffix = match[3] ?? "";
  const meridiem: Meridiem = suffix.startsWith("a")
    ? "a"
    : suffix.startsWith("p")
      ? "p"
      : suffix
        ? "h"
        : null;
  if (m > 59) return null;
  if (meridiem === "a" || meridiem === "p") {
    if (h < 1 || h > 12) return null;
  } else if (h > 24 || (h === 24 && m > 0)) {
    return null;
  }
  return { h, m, meridiem };
}

function to24(c: Clock, meridiem: Meridiem): number {
  const h = c.h === 24 ? 0 : c.h;
  if (meridiem === "a") return (h % 12) * 60 + c.m;
  if (meridiem === "p") return ((h % 12) + 12) * 60 + c.m;
  return h * 60 + c.m;
}

function hhmm(minutes: number): string {
  const within = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
}

const RANGE = /\s*(?:-|\u2013|\u2014|\bto\b|\bhasta\b|\s(?:a)\s(?=\d))\s*/u;

/** Reads a time or a time range typed as shorthand, or null when the text is not shorthand. */
export function parseTimeShorthand(
  text: string,
  options: TimeShorthandOptions = {},
): TimeShorthand | null {
  void options;
  const value = normalize(text);
  if (value === "") return null;
  const parts = value.split(RANGE).filter((p) => p !== "");
  if (parts.length === 1) {
    const one = readOne(parts[0] ?? "");
    return one ? { start: hhmm(to24(one, one.meridiem)), end: null, endDayOffset: 0 } : null;
  }
  if (parts.length !== 2) return null;
  const start = readOne(parts[0] ?? "");
  const end = readOne(parts[1] ?? "");
  if (!start || !end) return null;
  const endMinutes = to24(end, end.meridiem);
  let startMinutes = to24(start, start.meridiem);
  // The end's meridiem carries back to a bare start (8-11:30p is 20:00 to 23:30), unless that would put the start
  // after the end (10-2p is 10:00 to 14:00).
  if (start.meridiem === null && (end.meridiem === "a" || end.meridiem === "p") && start.h <= 12) {
    const carried = to24(start, end.meridiem);
    const other = to24(start, end.meridiem === "a" ? "p" : "a");
    startMinutes = carried <= endMinutes ? carried : other <= endMinutes ? other : carried;
  }
  return {
    start: hhmm(startMinutes),
    end: hhmm(endMinutes),
    endDayOffset: endMinutes <= startMinutes ? 1 : 0,
  };
}

/**
 * Reads a length typed as shorthand, in whole minutes: 45, 45m, 45 min, 90 min, 1h, 1 h, 1h30, 1:30, 1.5h. Null when
 * the text is not a length.
 */
export function parseDuration(text: string): number | null {
  const value = normalize(text).replace(/\s+/g, "");
  if (value === "") return null;
  let match = /^(\d+)(?:m|min|mins|minutes|minutos)?$/u.exec(value);
  if (match) return Number(match[1]);
  match = /^(\d+):(\d{2})$/u.exec(value);
  if (match) return Number(match[2]) > 59 ? null : Number(match[1]) * 60 + Number(match[2]);
  match = /^(\d+(?:[.,]\d+)?)(?:h|hr|hrs|hora|horas)(?:(\d{1,2})(?:m|min)?)?$/u.exec(value);
  if (match) {
    const hours = Number((match[1] ?? "0").replace(",", "."));
    const minutes = match[2] ? Number(match[2]) : 0;
    if (minutes > 59) return null;
    return Math.round(hours * 60) + minutes;
  }
  return null;
}
