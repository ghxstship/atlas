/** Locale-aware formatting through Intl. Nothing here stores a display format; values are formatted at render. */

export function formatNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatCurrency(locale: string, value: number, currency = "USD"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
}

/** Compact axis ticks (`notation: compact`), as the data visualization rules require. */
export function formatCompact(locale: string, value: number, currency?: string): string {
  return new Intl.NumberFormat(
    locale,
    currency === undefined
      ? { notation: "compact", maximumFractionDigits: 1 }
      : { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 },
  ).format(value);
}

export function formatList(locale: string, items: string[]): string {
  return new Intl.ListFormat(locale).format(items);
}

interface WeekInfoLocale {
  getWeekInfo?: () => { firstDay: number };
  weekInfo?: { firstDay: number };
}

/** First day of the week for a locale, 0 for Sunday through 6 for Saturday. */
export function weekStart(locale: string): number {
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
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
    new Date(y, m, 1),
  );
}

/** Short weekday names starting from the locale's first day of the week. */
export function weekdayNames(locale: string): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const start = weekStart(locale);
  // 2026-02-01 is a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    formatter.format(new Date(2026, 1, 1 + ((start + i) % 7))),
  );
}

export function formatDate(locale: string, iso: string): string {
  const { y, m, d } = parseIso(iso);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(y, m, d));
}

export function formatTimeOfDay(locale: string, hours: number, minutes: number): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(2026, 0, 1, hours, minutes),
  );
}

/** Month cells for a calendar grid: leading and trailing nulls pad whole weeks. */
export function monthCells(locale: string, y: number, m: number): (number | null)[][] {
  const first = (new Date(y, m, 1).getDay() - weekStart(locale) + 7) % 7;
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
