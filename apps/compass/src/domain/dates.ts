/**
 * Dates on the right calendar (A71's rule, A92). A calendar date (a per diem day, a timesheet period, an expense's
 * date) is the same day everywhere, so it is shown as written and never shifted by the phone's zone. An instant (a
 * flight's departure, a due time) is shown in the zone of the place it belongs to: a project's time zone, a travel
 * segment's own departure or arrival zone, or the person's own zone when nothing names one. "Today" is today on that
 * calendar (@xos/data/calendar), as Gateway's engagement view does (`todayIn(engagement.projectTimeZone)`).
 */
import { dateIn, isTimeZone, todayIn } from "@xos/data/calendar";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The zone to use for a place: its own when known, else the person's (the device's). */
export function zoneOr(
  zone: string | null | undefined,
  fallback?: string | null,
): string | undefined {
  if (isTimeZone(zone)) return zone;
  if (isTimeZone(fallback)) return fallback;
  return undefined;
}

/** The calendar date an instant falls on in a place's zone; the device's zone when the place names none. */
export function dayIn(iso: string, zone: string | null | undefined): string {
  return dateIn(new Date(iso), zoneOr(zone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** Today on a place's calendar as YYYY-MM-DD; the device's own day when the place names no zone. */
export function todayOn(zone: string | null | undefined, now: Date = new Date()): string {
  return todayIn(zoneOr(zone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now);
}

/** A calendar date (YYYY-MM-DD, or the date part of a timestamp) as "Wed, Jun 10", never shifted a day. */
export function formatCalendarDay(day: string, locale?: string): string {
  const date = day.slice(0, 10);
  if (!ISO_DAY.test(date)) return day;
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * A range of calendar dates, joined by the catalog's words ("Jun 10 to Jun 12"), or one day when both ends match.
 */
export function formatCalendarRange(
  start: string,
  end: string | null | undefined,
  between: (from: string, to: string) => string,
  locale?: string,
): string {
  if (!end || end.slice(0, 10) === start.slice(0, 10)) return formatCalendarDay(start, locale);
  return between(formatCalendarDay(start, locale), formatCalendarDay(end, locale));
}

/** An instant in a place's zone as "Wed, Jun 10, 6:30 PM", with the zone's short name when it is not the phone's. */
export function formatInstant(
  iso: string,
  zone: string | null | undefined,
  locale?: string,
  deviceZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const timeZone = zoneOr(zone);
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
    ...(timeZone && timeZone !== deviceZone ? { timeZoneName: "short" as const } : {}),
  }).format(at);
}

/** Whole days from today to a calendar date on the same calendar: negative when it has passed. */
export function daysUntil(day: string, today: string): number {
  return Math.round(
    (Date.parse(`${day.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}
