/**
 * Server-side formatting for Gateway pages. Money is stored in integer minor units (Section 3.11);
 * null is unpriced and is never formatted as zero, so these helpers take null and say so. Dates
 * stored as ISO dates are formatted in UTC so a calendar date never shifts a day across zones.
 */

/** The number of minor units in one major unit of a currency (100 for USD, 1 for JPY). */
export function minorDigits(currency: string): number {
  return (
    new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** A money amount in minor units, or null when the amount or currency is missing. */
export function formatMoney(
  locale: string,
  minor: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (minor === null || minor === undefined || !currency) return null;
  const digits = minorDigits(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    minor / 10 ** digits,
  );
}

/** A posted pay range: one amount, a range, or null for Rate on Request. */
export function formatPayRange(
  locale: string,
  min: number | null,
  max: number | null,
  currency: string | null,
): string | null {
  if (min !== null && max !== null && currency && min !== max) {
    const digits = minorDigits(currency);
    return new Intl.NumberFormat(locale, { style: "currency", currency }).formatRange(
      min / 10 ** digits,
      max / 10 ** digits,
    );
  }
  return formatMoney(locale, min ?? max, currency);
}

/** Major units typed into a form, to minor units; null for a blank field (never zero). */
export function parseMoneyInput(text: string, currency: string): number | null {
  const cleaned = text.replace(/[^0-9.]/g, "");
  if (cleaned.length === 0) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10 ** minorDigits(currency));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date or a timestamp as a short date. */
export function formatDate(locale: string, iso: string): string {
  const date = DATE_ONLY.test(iso) ? new Date(`${iso}T00:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(DATE_ONLY.test(iso) ? { timeZone: "UTC" } : {}),
  }).format(date);
}

/** A first and last date, collapsing a single day. */
export function formatDateRange(locale: string, start: string | null, end: string | null): string {
  if (!start) return end ? formatDate(locale, end) : "";
  if (!end || end === start) return formatDate(locale, start);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(
    new Date(`${start.slice(0, 10)}T00:00:00Z`),
    new Date(`${end.slice(0, 10)}T00:00:00Z`),
  );
}

/** A timestamp with time, in the record's own zone when it has one. */
export function formatDateTime(locale: string, iso: string, timeZone?: string | null): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone, timeZoneName: "short" } : {}),
  }).format(new Date(iso));
}

/** Time until a moment, as Intl relative time: "in 3 days", "in 5 hours", "in 12 minutes". */
export function formatCountdown(locale: string, iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const minutes = Math.round(ms / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

/** Today as an ISO date in UTC. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The ISO date a number of days from today (UTC). */
export function isoDaysFromToday(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
