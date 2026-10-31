import { MAX_LIVE_LINK_DAYS } from "@xos/data/live-links";

/**
 * The instant a live link picked for a calendar day expires (P1, ADR 0130): the end of that day in
 * UTC, kept inside the 90 days the database allows, so the last day offered is never refused. It
 * lives outside the "use server" actions so it is a plain helper, not a callable server action.
 */
export function expiryFor(day: string, now: Date = new Date()): string {
  const end = Date.parse(`${day}T23:59:59Z`);
  const ceiling = now.getTime() + MAX_LIVE_LINK_DAYS * 86_400_000 - 60_000;
  return new Date(Math.min(end, ceiling)).toISOString();
}
