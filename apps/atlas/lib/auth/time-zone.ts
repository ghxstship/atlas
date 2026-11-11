import { isTimeZone } from "@xos/data/calendar";

/**
 * The time zone a new organization starts in: the creator's browser zone when it is a real IANA zone other than UTC,
 * which locale.time_zone already defaults to. Without it a US org created in the evening dated its records a day
 * ahead of its members (crawl 4.9). The Owner can change it in Settings, Localization.
 */
export function signupTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const zone = value.trim();
  if (zone.length === 0 || zone.length > 64 || zone === "UTC" || zone === "Etc/UTC") return null;
  return isTimeZone(zone) ? zone : null;
}
