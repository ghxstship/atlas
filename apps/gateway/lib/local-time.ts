/**
 * A `datetime-local` value read in an IANA zone, as an ISO instant. Arrival windows and allocation windows
 * are typed in the project's zone (Section 7.1), never the browser's.
 */
export function localToInstant(local: string, timeZone: string): string {
  const asUtc = new Date(`${local}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return local;
  if (!timeZone) return asUtc.toISOString();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(asUtc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(asUtc.getTime() - (shown - asUtc.getTime())).toISOString();
}
