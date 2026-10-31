/**
 * Formatting helpers shared by server and client components of the Schedule, Work and Show pages.
 * Stored canon values are mapped to @xos/ui tokens and catalog keys here, never retyped as lists.
 */
import {
  displayTimeZone,
  formatZonedDateTime,
  type DisplayPreferences,
  type TimeZoneDisplay,
} from "@xos/ui/preferences";

/** The @xos/ui state token of a stored record state: "In Review" to "in-review". */
export function stateToken(
  state: string,
):
  | "proposed"
  | "ready"
  | "scheduled"
  | "active"
  | "blocked"
  | "in-review"
  | "complete"
  | "deferred"
  | "canceled" {
  return state.toLowerCase().replace(/\s+/g, "-") as ReturnType<typeof stateToken>;
}

/** The @xos/ui state token that best shows a work order state on a board or chip. */
export function workOrderToken(state: string): ReturnType<typeof stateToken> {
  switch (state) {
    case "Draft":
      return "proposed";
    case "Open":
      return "ready";
    case "Awarded":
      return "scheduled";
    case "In Progress":
      return "active";
    default:
      return stateToken(state);
  }
}

/** A short date and time in a time zone, or the fallback when there is no value. */
export function formatWhen(
  value: string | null,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(value));
}

/** How a viewer reads schedule times: their me.time_zone_display choice and their own zone. */
export interface ScheduleView {
  readonly display: TimeZoneDisplay;
  readonly viewerZone: string | null;
}

export const EVENT_ZONE_VIEW: ScheduleView = { display: "event", viewerZone: null };

/**
 * A schedule time (Section 15): in the event's zone by default, or the viewer's own when they chose "my time
 * zone" (me.time_zone_display), always labeled with the zone abbreviation, for example "Oct 21, 2026, 7:30 PM
 * EDT" or "7:30 PM EDT". Null when there is no value.
 */
export function formatScheduleTime(
  value: string | null,
  locale: string,
  eventZone: string | null | undefined,
  view: ScheduleView,
  parts: "dateTime" | "time" = "dateTime",
): string | null {
  if (!value) return null;
  const zone = displayTimeZone(eventZone, view.display, view.viewerZone) ?? "UTC";
  return formatZonedDateTime(locale, value, zone, parts);
}

/**
 * A start time that may be an estimate to be confirmed (G-40, ADR 0131): the schedule time, or, while the start is
 * TBC, `tbc` applied to it ("TBC · est. 7:30 PM EDT"). Atlas is internal, so it always shows the estimate; sorting
 * and timeline placement keep using the estimate itself. Null when there is no value.
 */
export function formatStartTime(
  value: string | null,
  startTbc: boolean,
  locale: string,
  eventZone: string | null | undefined,
  view: ScheduleView,
  parts: "dateTime" | "time",
  tbc: (time: string) => string,
): string | null {
  const time = formatScheduleTime(value, locale, eventZone, view, parts);
  return time !== null && startTbc ? tbc(time) : time;
}

/** The viewer's schedule view from their resolved display preferences and own zone. */
export function scheduleViewOf(
  preferences: Pick<DisplayPreferences, "timeZoneDisplay">,
  viewerZone: string | null,
): ScheduleView {
  return { display: preferences.timeZoneDisplay, viewerZone };
}

/** A calendar day (YYYY-MM-DD) formatted in a locale without shifting zones. */
export function formatDay(
  day: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

/** Money in minor units, or null when unpriced (Section 3.7: NULL renders Unpriced, never zero). */
export function formatMoney(
  minor: number | null,
  currency: string,
  locale: string,
  exponent = 2,
): string | null {
  if (minor === null) return null;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minor / 10 ** exponent);
}

/** A datetime-local input value (YYYY-MM-DDTHH:MM) for an instant in a time zone. */
export function toLocalInput(value: string | null, timeZone: string): string {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** The instant a datetime-local input value names in a time zone, as ISO, or null when empty. */
export function fromLocalInput(value: string | null | undefined, timeZone: string): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - at;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first)).toISOString();
}

/**
 * How far a date moved, for the replan log and baseline variance: whole days from 12 hours up
 * (so a daylight saving change never shows as 1.96 days), hours below that, and null for no move.
 */
export function slipAmount(
  ms: number | null,
): { readonly late: boolean; readonly n: number; readonly unit: "days" | "hours" } | null {
  if (ms === null || ms === 0) return null;
  const hours = Math.abs(ms) / 3_600_000;
  if (hours >= 12) return { late: ms > 0, n: Math.round(hours / 24), unit: "days" };
  const n = Math.round(hours);
  return n === 0 ? null : { late: ms > 0, n, unit: "hours" };
}

/** Builds a URL of the current page with some query parameters set or removed. */
export function withQuery(
  pathname: string,
  current: URLSearchParams | Readonly<Record<string, string | undefined>>,
  changes: Readonly<Record<string, string | null | undefined>>,
): string {
  const next = new URLSearchParams(
    current instanceof URLSearchParams
      ? current
      : Object.entries(current).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  );
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}
