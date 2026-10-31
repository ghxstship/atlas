import { MAX_SHOWCALLER_LINK_DAYS } from "@xos/data/showcaller-links";

/**
 * The instant a showcaller link picked for a calendar day expires (B3, ADR 0142): the end of that day in UTC,
 * kept inside the 14 days the database allows, so the last day offered is never refused. A plain helper outside
 * the "use server" actions, as lib/live-links/expiry.ts is.
 */
export function showcallerExpiryFor(day: string, now: Date = new Date()): string {
  const end = Date.parse(`${day}T23:59:59Z`);
  const ceiling = now.getTime() + MAX_SHOWCALLER_LINK_DAYS * 86_400_000 - 60_000;
  return new Date(Math.min(end, ceiling)).toISOString();
}

/** True when a link expiring on `day` (or by default) would stop before the show day ends. */
export function expiresBeforeShow(day: string, showDate: string): boolean {
  return day !== "" && day < showDate;
}
