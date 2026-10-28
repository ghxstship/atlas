/**
 * Calendar dates in a place's time zone (A71, RRR-116). Servers and `toISOString()` work in UTC, which
 * is a day ahead every evening in the Americas: after 20:00 in New York "today" became tomorrow, a
 * week view moved to next week on Sunday night, and a payment defaulted to the next month on the last
 * evening of one. A project's dates follow its time zone and the org's follow its locale.time_zone
 * setting, the same calendars the database uses (private.project_today and private.org_today, 1305).
 */

const DAY_MS = 86_400_000;

/** True for a time zone name the runtime's IANA database knows. */
export function isTimeZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone itself when it is a known IANA zone, otherwise UTC (an unset or mistyped setting). */
export function zoneOrUtc(zone: string | null | undefined): string {
  return isTimeZone(zone) ? zone : "UTC";
}

/** The calendar date of an instant in a time zone, as `YYYY-MM-DD`; UTC for an unknown zone. */
export function dateIn(instant: Date, zone: string | null | undefined): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zoneOrUtc(zone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Today's date in a time zone, as `YYYY-MM-DD`; UTC for an unknown zone. */
export function todayIn(zone: string | null | undefined, now: Date = new Date()): string {
  return dateIn(now, zone);
}

/** Offset of a zone from UTC at an instant, in milliseconds (positive east of Greenwich). */
function offsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant a calendar day starts in a time zone, as an ISO string: the bound of a day or week
 * window on that place's calendar. Across a daylight saving change the offset is the one in force at
 * that midnight.
 */
export function startOfDayIn(day: string, zone: string | null | undefined): string {
  const z = zoneOrUtc(zone);
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  let instant = utcMidnight - offsetMs(new Date(utcMidnight), z);
  // A second pass settles a day whose midnight falls on the other side of a DST change.
  instant = utcMidnight - offsetMs(new Date(instant), z);
  return new Date(instant).toISOString();
}

/**
 * The instant a wall-clock time (`YYYY-MM-DDTHH:mm`, as a datetime-local input gives it) names in a
 * time zone, as an ISO string; null when the text is not such a time. Same two passes as
 * `startOfDayIn`, so a time just after a daylight saving change takes the new offset.
 */
export function instantOfLocalIn(local: string, zone: string | null | undefined): string | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$/.test(local)) return null;
  const asUtc = Date.parse(`${local.length === 16 ? `${local}:00` : local}Z`);
  if (Number.isNaN(asUtc)) return null;
  const z = zoneOrUtc(zone);
  let instant = asUtc - offsetMs(new Date(asUtc), z);
  instant = asUtc - offsetMs(new Date(instant), z);
  return new Date(instant).toISOString();
}

/** A `YYYY-MM-DD` date plus some days. */
export function addCalendarDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
