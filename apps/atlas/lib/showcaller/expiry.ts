import { MAX_SHOWCALLER_LINK_DAYS } from "@xos/data/showcaller-links";
import { fromLocalInput, toLocalInput } from "@/components/work/format";

/**
 * The instant a showcaller link picked for a calendar day expires (B3, ADR 0142): the end of that day in the project's
 * time zone, so a link picked for the show day outlives the show, kept inside the 14 days the database allows, so the
 * last day offered is never refused. A plain helper outside the "use server" actions, as lib/live-links/expiry.ts is.
 */
export function showcallerExpiryFor(
  day: string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const end = Date.parse(fromLocalInput(`${day}T23:59`, timeZone) ?? "");
  const ceiling = now.getTime() + MAX_SHOWCALLER_LINK_DAYS * 86_400_000 - 60_000;
  return new Date(Math.min(end, ceiling)).toISOString();
}

/** The calendar day `days` after today in a time zone, as the date input's min and max read it. */
export function showcallerDayFromToday(
  days: number,
  timeZone: string,
  now: Date = new Date(),
): string {
  const today = toLocalInput(now.toISOString(), timeZone).slice(0, 10);
  const [year = 0, month = 1, day = 1] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** True when a link expiring on `day` (or by default) would stop before the show day ends. */
export function expiresBeforeShow(day: string, showDate: string): boolean {
  return day !== "" && day < showDate;
}
