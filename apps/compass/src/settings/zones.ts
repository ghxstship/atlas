/**
 * The time zone picker of the settings screens (A111): every IANA zone the phone knows, searched by city or region,
 * the way Atlas lists them for locale.time_zone and quiet hours.
 */
import { isTimeZone } from "@xos/data/calendar";

/**
 * Zones offered when the runtime cannot list its own (an engine without Intl.supportedValuesOf): the US zones
 * first, then a city on each continent. A zone typed in full is always accepted as well (matchZones).
 */
export const COMMON_ZONES: readonly string[] = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Bogota",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** The runtime's own list of zones, or null for an engine without one. */
function runtimeZones(): ((key: "timeZone") => string[]) | null {
  const intl = Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] };
  return intl.supportedValuesOf ? (key) => intl.supportedValuesOf?.(key) ?? [] : null;
}

/** Every zone the runtime knows, UTC first, or COMMON_ZONES and UTC when it cannot list them. */
export function knownZones(
  list: ((key: "timeZone") => string[]) | null = runtimeZones(),
): string[] {
  const zones = list ? list("timeZone") : [...COMMON_ZONES];
  return ["UTC", ...zones.filter((z) => z !== "UTC")];
}

/** A zone as people read it: America/New_York is "America/New York". */
export function zoneLabel(zone: string): string {
  return zone.replaceAll("_", " ");
}

const fold = (value: string) => value.toLowerCase().replaceAll("_", " ").trim();

/**
 * The zones whose name holds what was typed (spaces and underscores alike, any case), at most `limit`, with the
 * device's zone first when it matches. A zone typed in full that the phone knows is offered even when the list
 * lacks it, so the fallback list never stops anyone choosing their zone.
 */
export function matchZones(
  query: string,
  zones: readonly string[],
  deviceZone: string | null = null,
  limit = 60,
): string[] {
  const q = fold(query);
  const typed = query.trim();
  const hits = zones.filter((z) => q === "" || fold(z).includes(q));
  const exact = isTimeZone(typed) && !hits.includes(typed) ? [typed] : [];
  const device = deviceZone && hits.includes(deviceZone) ? [deviceZone] : [];
  const rest = hits.filter((z) => z !== deviceZone);
  return [...exact, ...device, ...rest].slice(0, limit);
}
