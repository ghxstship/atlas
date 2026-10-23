/** Schedule times on the device (Section 15), kept free of React Native so tests can run them. */

/**
 * A time of day. Given a zone (a schedule time, Section 15), it shows in that zone with the zone's abbreviation;
 * without one, in the device's zone, unlabeled.
 */
export function formatTime(iso: string, timeZone?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone, timeZoneName: "short" } : {}),
  }).format(new Date(iso));
}

export function formatDay(iso: string, timeZone?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}
