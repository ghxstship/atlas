import type { Engagement, Representation, Result, XosClient } from "@xos/data/gateway";
import { getEngagement } from "@xos/data/gateway";
import {
  getMyRosterEngagement,
  PENDING_PICKUP_STATUSES,
  parkingLine,
  type DisplayStatus,
  type EngagedAllocation,
  type ParkingPass,
  type RosterEngagement,
} from "@xos/data/gateway-allocations";
import type { EngagementTabSetKey } from "@xos/ia";
import { sitemapRoleType } from "./engagement-state";
import type { Tone } from "./states";

/**
 * A person on a party's roster in Gateway (R8, ADR 0100 roster-member): the Up Next card of their own
 * call, parking and gear, and the Assigned to you list. Pure, so the rules are unit tested; the one
 * read, resolveEngagement, takes the client.
 */

/** How the viewer reaches an engagement: as a party (api_external.engagements) or only through a roster entry. */
export type EngagementReach =
  | { readonly via: "engagement"; readonly engagement: Engagement }
  | { readonly via: "roster"; readonly engagement: RosterEngagement };

/**
 * The engagement an id names for the viewer: the party's read first, and when that answers
 * not-found, the engagements the viewer reaches only through a roster entry
 * (api_external.my_roster_engagements). Any other failure is the party read's.
 */
export async function resolveEngagement(
  db: XosClient,
  id: string,
): Promise<Result<EngagementReach>> {
  const party = await getEngagement(db, id);
  if (party.ok) return { ok: true, data: { via: "engagement", engagement: party.data } };
  if (party.error.kind !== "not-found") return party;
  const roster = await getMyRosterEngagement(db, id);
  if (!roster.ok) return roster;
  return { ok: true, data: { via: "roster", engagement: roster.data } };
}

/**
 * The tab set a viewer sees (Section 4.5.8): roster-staff for a person on a staffing agency's roster (R12),
 * roster-member for anyone else who reaches the engagement only through the roster, artist-representative for a
 * live representation, else the engagement's role type.
 */
export function engagementTabSet(
  reach: EngagementReach,
  representation: Representation | null,
): EngagementTabSetKey {
  if (reach.via === "roster")
    return reach.engagement.roleType === "Staff" ? "roster-staff" : "roster-member";
  return representation ? "artist-representative" : sitemapRoleType(reach.engagement.roleType);
}

/** When to be there: the earliest of the person's own shifts today, else the start of their arrival window. */
export interface RosterCall {
  readonly at: string;
  readonly timeZone: string;
  readonly source: "shift" | "arrival";
}

export function rosterCall(input: {
  readonly engagement: Pick<
    RosterEngagement,
    "arrivalStartsAt" | "arrivalTimeZone" | "projectTimeZone"
  >;
  /** The person's own shifts; a person on a roster usually has none of their own. */
  readonly shifts: readonly { readonly startsAt: string; readonly timeZone: string }[];
  /** Today on the project calendar, `YYYY-MM-DD`. */
  readonly today: string;
}): RosterCall | null {
  const todays = input.shifts
    .filter((s) => localDay(s.startsAt, input.engagement.projectTimeZone) === input.today)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  if (todays) return { at: todays.startsAt, timeZone: todays.timeZone, source: "shift" };
  const { arrivalStartsAt, arrivalTimeZone, projectTimeZone } = input.engagement;
  return arrivalStartsAt
    ? { at: arrivalStartsAt, timeZone: arrivalTimeZone ?? projectTimeZone, source: "arrival" }
    : null;
}

/** An instant's day in a time zone, `YYYY-MM-DD`. */
export function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** The person's own rows, live or decided, earliest need first; withdrawn rows drop out. */
export function assignedToYou(
  allocations: readonly EngagedAllocation[],
  rosterEntryIds: readonly string[],
): EngagedAllocation[] {
  const mine = new Set(rosterEntryIds);
  return allocations
    .filter((a) => a.rosterEntryId !== null && mine.has(a.rosterEntryId) && a.state !== "Withdrawn")
    .sort((a, b) => a.neededFrom.localeCompare(b.neededFrom));
}

/** What to bring and pick up: issued items first, then approved ones waiting at the desk. */
export function rosterBring(allocations: readonly EngagedAllocation[]): string[] {
  const label = (a: EngagedAllocation) => a.itemName ?? a.kind;
  const issued = allocations.filter((a) => a.status === "Issued" || a.status === "Partly Issued");
  const pending = allocations.filter(
    (a) => a.state === "Approved" && PENDING_PICKUP_STATUSES.includes(a.status),
  );
  return [...new Set([...issued.map(label), ...pending.map(label)])];
}

/** The live parking passes in one line each: zones, then make, model and colour (never a plate). */
export function parkingLines(passes: readonly ParkingPass[]): string[] {
  return passes.filter((p) => p.revokedAt === null).map(parkingLine);
}

/** The tag tone of an allocation's computed status. */
export function allocationTone(status: DisplayStatus): Tone {
  switch (status) {
    case "Issued":
    case "Returned":
      return "success";
    case "Declined":
    case "Revoked":
      return "danger";
    case "Withdrawn":
      return "neutral";
    case "Requested":
      return "accent";
    default:
      return "warning";
  }
}

/** True for a viewer who reaches the engagement only through their own roster entry (R8 and R12). */
export function onRoster(view: { readonly roleType: EngagementTabSetKey }): boolean {
  return view.roleType === "roster-member" || view.roleType === "roster-staff";
}
