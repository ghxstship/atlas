import { MAX_LIVE_LINK_DAYS } from "@xos/data/live-links";
import { localToInstant } from "@/lib/operations/time";

/**
 * The instant a live link picked for a calendar day expires (P1, ADR 0130): the end of that day in
 * the project's time zone, never a UTC day, so a link picked for the show day lasts through it
 * wherever the project is. It is kept inside the 90 days the database allows, so the last day
 * offered is never refused. It lives outside the "use server" actions so it is a plain helper,
 * not a callable server action.
 */
export function expiryFor(day: string, timeZone: string, now: Date = new Date()): string {
  const end = localToInstant(`${day}T23:59`, timeZone);
  const ceiling = now.getTime() + MAX_LIVE_LINK_DAYS * 86_400_000 - 60_000;
  const wanted = end === null ? ceiling : Date.parse(end) + 59_000;
  return new Date(Math.min(wanted, ceiling)).toISOString();
}
