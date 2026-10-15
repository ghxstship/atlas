/**
 * Local times are typed in the project's time zone (app.projects.time_zone, Section 4.10) and stored
 * as instants. These helpers convert between a `datetime-local` value and an ISO instant in a named
 * IANA zone without a date library.
 */

function zoneOffsetMs(instant: Date, timeZone: string): number {
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
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/** `2026-10-14T19:30` in `America/New_York` to its ISO instant; null for an empty or bad value. */
export function localToInstant(local: string | null | undefined, timeZone: string): string | null {
  if (!local || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const naive = new Date(`${local}:00Z`);
  if (Number.isNaN(naive.getTime())) return null;
  const first = naive.getTime() - zoneOffsetMs(naive, timeZone);
  const second = naive.getTime() - zoneOffsetMs(new Date(first), timeZone);
  return new Date(second).toISOString();
}

/** An ISO instant to a `datetime-local` value in the zone; empty for null. */
export function instantToLocal(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return "";
  return new Date(instant.getTime() + zoneOffsetMs(instant, timeZone)).toISOString().slice(0, 16);
}
