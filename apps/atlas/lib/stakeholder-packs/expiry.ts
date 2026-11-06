import { MAX_PACK_DAYS } from "@xos/data/stakeholder-packs";
import { localToInstant } from "@/lib/operations/time";

/**
 * The instant a link picked for a calendar day expires (B2, ADR 0141): the end of that day in the
 * project's zone, kept inside the 90 days the database allows, so the last day offered is never refused.
 * Time on a project uses its zone, never UTC days; P1's lib/live-links/expiry.ts ends a link at UTC
 * midnight and is left alone here (noted for the orchestrator). A plain helper, not a server action.
 */
export function endOfDayInZone(day: string, timeZone: string, now: Date = new Date()): string {
  const end = localToInstant(`${day}T23:59`, timeZone);
  const ceiling = now.getTime() + MAX_PACK_DAYS * 86_400_000 - 60_000;
  const wanted = end === null ? ceiling : Date.parse(end) + 59_000;
  return new Date(Math.min(wanted, ceiling)).toISOString();
}

/** A calendar day `offset` days from today in the zone, as a date input wants it. */
export function dayInZone(offset: number, timeZone: string, now: Date = new Date()): string {
  const day = new Date(now.getTime() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(day);
}
