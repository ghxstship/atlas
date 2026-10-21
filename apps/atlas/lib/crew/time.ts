/**
 * Zone-aware time helpers for Crew forms and views. Shift times are typed in the project's IANA zone
 * (app.shifts.time_zone) and stored as instants, so a form value like 2027-06-01T08:00 in
 * America/New_York becomes 2027-06-01T12:00:00.000Z. Pure functions on Intl, with no clock reads.
 */

function partsIn(instant: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const out: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** Offset of a zone from UTC at an instant, in minutes (New York in June: -240). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  const asUtc = Date.UTC(
    p["year"] ?? 0,
    (p["month"] ?? 1) - 1,
    p["day"] ?? 1,
    p["hour"] ?? 0,
    p["minute"] ?? 0,
    p["second"] ?? 0,
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** A `datetime-local` value in a zone to an ISO instant; null when the value is malformed. */
export function zonedToIso(local: string, timeZone: string): string | null {
  const m = LOCAL.exec(local);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(guess)) return null;
  // Two passes settle the offset across a daylight saving change.
  let instant = guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
  instant = guess - zoneOffsetMinutes(new Date(instant), timeZone) * 60_000;
  return new Date(instant).toISOString();
}

/** An ISO instant to a `datetime-local` value in a zone, for editing. */
export function isoToZoned(iso: string, timeZone: string): string {
  const p = partsIn(new Date(iso), timeZone);
  const pad = (n: number | undefined) => String(n ?? 0).padStart(2, "0");
  return `${p["year"]}-${pad(p["month"])}-${pad(p["day"])}T${pad(p["hour"])}:${pad(p["minute"])}`;
}

/** The calendar day of an instant in a zone, as an ISO date. */
export function dayIn(iso: string, timeZone: string): string {
  return isoToZoned(iso, timeZone).slice(0, 10);
}

/** Monday of the week holding an ISO date. */
export function mondayOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

/**
 * The first day of the week containing an ISO date, for a first day of 0 (Sunday) or 1 (Monday), the
 * person's or org's payroll.week_start.
 */
export function weekStartOf(isoDate: string, firstDay: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const shift = (d.getUTCDay() - firstDay + 7) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

/** An ISO date plus some days. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string | undefined): value is string {
  return (
    value !== undefined && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

/** Hours with up to two decimals from minutes (worked minutes are integers). */
export function hoursFromMinutes(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}
