import {
  addDays,
  parseDuration,
  parseTimeShorthand,
  zonedInstant,
  type QuickAddParse,
} from "@xos/ui/quick-add";

/**
 * Reading a schedule grid's Time and Duration cells (B4, G-41) into instants on a project's wall clock. Time shorthand
 * comes first (8a-10:30a, 830p, 20 h); a phrase that is not shorthand falls back to quick add's date reading, passed in
 * by the grid (parseQuickAdd with the grid's day as reference and the project's zone), so this module stays free of
 * chrono and runs anywhere.
 */

export interface GridWindow {
  /** Start of the window, or null for a due-only time. */
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** A single time on a record reads as its due time. */
  readonly dueAt: string | null;
}

export type QuickAddReader = (text: string) => QuickAddParse;

/** The wall-clock label a grid shows for a window: 08:00–10:30, or 19:00 for a single time; "+1" marks the next day. */
export function windowLabel(start: string, end: string | null, endDayOffset: 0 | 1): string {
  return end ? `${start}–${end}${endDayOffset ? " +1" : ""}` : start;
}

/** Normalizes what a person typed into the label the cell keeps, or the text as typed when it does not read. */
export function normalizeTimeCell(text: string, locale: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const s = parseTimeShorthand(trimmed, { locale });
  return s ? windowLabel(s.start, s.end, s.endDayOffset) : trimmed;
}

const LABEL = /^(\d{2}:\d{2})(?:\u2013(\d{2}:\d{2}))?( \+1)?$/u;

/**
 * A Time cell as a window on `day` in `zone`: a range is a start and an end (an end at or before the start is the next
 * day), a single time is due then. Null when the text reads as neither shorthand nor a quick add date.
 */
export function readTimeCell(
  text: string,
  day: string,
  zone: string,
  locale: string,
  quickAdd?: QuickAddReader,
): GridWindow | null {
  const trimmed = text.trim();
  if (trimmed === "") return { startsAt: null, endsAt: null, dueAt: null };
  const label = LABEL.exec(trimmed);
  const s = label
    ? { start: label[1] ?? "", end: label[2] ?? null, endDayOffset: (label[3] ? 1 : 0) as 0 | 1 }
    : parseTimeShorthand(trimmed, { locale });
  if (s) {
    // A single time marked +1 is on the next day (a cue after midnight on a show day).
    const startDay = label && !label[2] && label[3] ? addDays(day, 1) : day;
    const start = zonedInstant(startDay, s.start, zone);
    if (!s.end) return { startsAt: null, endsAt: null, dueAt: start };
    const rolls = s.endDayOffset === 1 || s.end <= s.start;
    return {
      startsAt: start,
      endsAt: zonedInstant(rolls ? addDays(day, 1) : day, s.end, zone),
      dueAt: null,
    };
  }
  const parsed = quickAdd?.(trimmed);
  const date = parsed?.tokens.find((token) => token.type === "date");
  if (!date?.iso || !date.time) return null;
  const start = zonedInstant(date.iso, date.time, zone);
  if (!date.endTime) return { startsAt: null, endsAt: null, dueAt: start };
  return {
    startsAt: start,
    endsAt: zonedInstant(date.endIso ?? date.iso, date.endTime, zone),
    dueAt: null,
  };
}

/** A Duration cell in whole minutes, 0 to 1440, or null when it does not read. */
export function readDurationCell(text: string | null): number | null {
  if (text === null || text.trim() === "") return null;
  const minutes = parseDuration(text);
  return minutes !== null && minutes >= 0 && minutes <= 1440 ? minutes : null;
}

/** The wall-clock HH:MM of an instant in a zone. */
export function wallTime(at: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
}

/** The calendar date of an instant in a zone, YYYY-MM-DD. */
export function wallDate(at: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/**
 * The Time cell label of a stored window, read on the zone's wall clock. With `day`, a single time that falls on the
 * next day is marked +1, so it reads back onto that day.
 */
export function cellOfWindow(
  w: {
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly dueAt: string | null;
  },
  zone: string,
  day?: string,
): string | null {
  if (w.startsAt) {
    if (!w.endsAt) return wallTime(w.startsAt, zone);
    const nextDay = wallDate(w.endsAt, zone) > wallDate(w.startsAt, zone);
    return windowLabel(wallTime(w.startsAt, zone), wallTime(w.endsAt, zone), nextDay ? 1 : 0);
  }
  if (!w.dueAt) return null;
  return day && wallDate(w.dueAt, zone) > day
    ? `${wallTime(w.dueAt, zone)} +1`
    : wallTime(w.dueAt, zone);
}

/** Truthy TBC cells: TBC, yes, sí, x, 1, true. */
export function readTbcCell(value: string | number | null): boolean {
  if (value === null) return false;
  return /^(tbc|yes|y|s[ií]|x|1|true|pendiente)$/iu.test(String(value).trim());
}
