/** Locale-aware formatting through Intl. Nothing here stores a display format; values are formatted at render. */

/*
 * Intl formatters are reused per locale and options. Building one loads locale data and costs far
 * more than formatting with it: a table built a currency formatter per Money cell, and the first
 * formatters of a page were a large part of its hydration time on a slow CPU (gate 10, Total
 * Blocking Time).
 */
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const listFormats = new Map<string, Intl.ListFormat>();

function cached<T>(cache: Map<string, T>, key: string, make: () => T): T {
  let formatter = cache.get(key);
  if (formatter === undefined) {
    formatter = make();
    cache.set(key, formatter);
  }
  return formatter;
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  return cached(numberFormats, `${locale}|${JSON.stringify(options)}`, () => {
    return new Intl.NumberFormat(locale, options);
  });
}

function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached(dateTimeFormats, `${locale}|${JSON.stringify(options)}`, () => {
    return new Intl.DateTimeFormat(locale, options);
  });
}

export function formatNumber(locale: string, value: number): string {
  return numberFormat(locale).format(value);
}

/**
 * A date and time in a given IANA zone, always labeled with the zone's abbreviation (Section 15: schedule
 * times "always labeled with the zone abbreviation"), for example "Oct 21, 2026, 7:30 PM EDT". `timeZoneName`
 * cannot be combined with dateStyle or timeStyle, so the parts are spelled out.
 */
export function formatZonedDateTime(
  locale: string,
  iso: string | Date,
  timeZone: string,
  parts: "dateTime" | "time" = "dateTime",
): string {
  const options: Intl.DateTimeFormatOptions =
    parts === "time"
      ? { hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }
      : {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone,
          timeZoneName: "short",
        };
  return dateTimeFormat(locale, options).format(typeof iso === "string" ? new Date(iso) : iso);
}

/** Whether a schedule shows times in the event's zone or the viewer's own (me.time_zone_display). */
export type TimeZoneDisplay = "event" | "viewer";

/**
 * The zone a schedule time is shown in (Section 15): the event's (the venue's or project's) by default, or
 * the viewer's own when they chose that (me.time_zone_display) and their zone is known.
 */
export function displayTimeZone(
  eventZone: string | null | undefined,
  display: TimeZoneDisplay,
  viewerZone: string | null | undefined,
): string | undefined {
  if (display === "viewer" && viewerZone) return viewerZone;
  return eventZone ?? viewerZone ?? undefined;
}

export function formatCurrency(locale: string, value: number, currency = "USD"): string {
  return numberFormat(locale, { style: "currency", currency }).format(value);
}

/** Compact axis ticks (`notation: compact`), as the data visualization rules require. */
export function formatCompact(locale: string, value: number, currency?: string): string {
  return numberFormat(
    locale,
    currency === undefined
      ? { notation: "compact", maximumFractionDigits: 1 }
      : { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 },
  ).format(value);
}

export function formatList(locale: string, items: string[]): string {
  return cached(listFormats, locale, () => new Intl.ListFormat(locale)).format(items);
}

interface WeekInfoLocale {
  getWeekInfo?: () => { firstDay: number };
  weekInfo?: { firstDay: number };
}

/**
 * First day of the week, 0 for Sunday through 6 for Saturday: the person's choice when given
 * (payroll.week_start), otherwise the locale's.
 */
export function weekStart(locale: string, override: number | null = null): number {
  if (override !== null) return override;
  try {
    const intlLocale = new Intl.Locale(locale) as Intl.Locale & WeekInfoLocale;
    const info = intlLocale.getWeekInfo ? intlLocale.getWeekInfo() : intlLocale.weekInfo;
    return info ? info.firstDay % 7 : 0;
  } catch (error) {
    if (error instanceof RangeError) return 0;
    throw error;
  }
}

export interface IsoParts {
  y: number;
  m: number;
  d: number;
}

export function parseIso(value: string): IsoParts {
  const [y = "1970", m = "1", d = "1"] = value.split("-");
  return { y: Number(y), m: Number(m) - 1, d: Number(d) };
}

export function toIso(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function monthTitle(locale: string, y: number, m: number): string {
  return dateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(y, m, 1));
}

/** Short weekday names starting from the first day of the week. */
export function weekdayNames(locale: string, override: number | null = null): string[] {
  const formatter = dateTimeFormat(locale, { weekday: "short" });
  const start = weekStart(locale, override);
  // 2026-02-01 is a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    formatter.format(new Date(2026, 1, 1 + ((start + i) % 7))),
  );
}

/** A calendar date for display: by the locale, or year-month-day everywhere (locale.date_format iso). */
export function formatDate(
  locale: string,
  iso: string,
  dateFormat: "locale" | "iso" = "locale",
): string {
  const { y, m, d } = parseIso(iso);
  if (dateFormat === "iso") return toIso(y, m, d);
  return dateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(y, m, d),
  );
}

export function formatTimeOfDay(locale: string, hours: number, minutes: number): string {
  return dateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(2026, 0, 1, hours, minutes),
  );
}

/** Month cells for a calendar grid: leading and trailing nulls pad whole weeks. */
export function monthCells(
  locale: string,
  y: number,
  m: number,
  override: number | null = null,
): (number | null)[][] {
  const first = (new Date(y, m, 1).getDay() - weekStart(locale, override) + 7) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = Array.from({ length: first }, () => null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
  return weeks;
}

/** Seconds as mm:ss; a negative value (overrun) reads +mm:ss. */
export function formatClock(seconds: number): string {
  const over = seconds < 0;
  const s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  return `${over ? "+" : ""}${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
