import type { Engagement } from "@xos/data/gateway";
import type { Condition } from "@xos/ia";
import type { RosterEntry } from "@xos/data/roster";
import { rosterFactChip, type RosterFactStatus } from "@xos/data/roster-facts";

/**
 * The crew roster in Gateway (R4, ADR 0101). Pure, so who sees the Crew tab is unit tested.
 */

/**
 * ADR 0101 decision 8: an Artist engagement, or a company engagement (an account supplies it) of a
 * Vendor, Contractor, Staff or Sponsor, carries a roster beyond the engaged person's own entry.
 */
export function engagementRosterable(
  engagement: Pick<Engagement, "roleType" | "accountId">,
): boolean {
  if (engagement.roleType === "Artist") return true;
  return (
    engagement.accountId !== null &&
    ["Vendor", "Contractor", "Staff", "Sponsor"].includes(engagement.roleType)
  );
}

/**
 * roster-manager when the roster area is open to the viewer (the account's Owner or Admin, an
 * Advancing Lead, an Advance representative, or the engaged person of an Artist engagement) on a
 * rosterable engagement: the database's private.can_manage_roster, read from the engagement's
 * areas. The worker a company engagement names is on its roster, so their areas carry no roster.
 */
export function rosterConditions(
  engagement: Pick<Engagement, "roleType" | "accountId" | "areas">,
): Condition[] {
  return engagement.areas.includes("roster") && engagementRosterable(engagement)
    ? ["roster-manager"]
    : [];
}

type SubmittableEntry = Pick<RosterEntry, "isSelf" | "personId" | "entryState" | "personResponse">;

/** An entry the submit can move: not the self entry, naming a person who has not declined it. */
function submittable(e: SubmittableEntry): boolean {
  return !e.isSelf && e.personId !== null && e.personResponse !== "Declined";
}

/**
 * The entries Submit moves for review, as private.submit_roster_entries moves them (904110601): Returned entries, and
 * Drafts unless names are locked (4656). An entry whose person declined stays with the lead to replace or withdraw.
 */
export function rosterEntriesToSubmit<T extends SubmittableEntry>(
  entries: readonly T[],
  locked: boolean,
): T[] {
  return entries.filter(
    (e) => submittable(e) && (e.entryState === "Returned" || (e.entryState === "Draft" && !locked)),
  );
}

/** Drafts a names lock holds back from the submit; none while unlocked. */
export function rosterDraftsHeld(entries: readonly SubmittableEntry[], locked: boolean): number {
  return locked ? entries.filter((e) => submittable(e) && e.entryState === "Draft").length : 0;
}

type FactKind = "travel" | "uniform" | "vehicle";

/** One person on the engagement's roster who owes project details the viewer cannot enter as their own. */
export interface OwedFacts {
  readonly rosterEntryId: string;
  readonly name: string | null;
  /** The kinds the project asks of them, each on file or missing; never a kind that is not offered. */
  readonly kinds: readonly { readonly kind: FactKind; readonly chip: "onFile" | "missing" }[];
}

/**
 * What the rest of the roster owes in project details (R5), for someone who manages it without being on it, such as an
 * artist's representative (4.9 surface crawl): each live entry of another person who has not declined it, with the kinds
 * the project asks and whether each is on file, as app.roster_project_fact_status reports them to the viewer.
 */
export function othersOwedFacts(
  entries: readonly Pick<
    RosterEntry,
    "id" | "personId" | "fullName" | "entryState" | "personResponse"
  >[],
  statuses: readonly Pick<RosterFactStatus, "rosterEntryId" | "offered" | "present">[],
  viewerPersonId: string,
): OwedFacts[] {
  const statusOf = new Map(statuses.map((s) => [s.rosterEntryId, s]));
  return entries.flatMap((e) => {
    const status = statusOf.get(e.id);
    if (
      !status ||
      e.personId === viewerPersonId ||
      e.entryState === "Withdrawn" ||
      e.personResponse === "Declined"
    )
      return [];
    const kinds = (["travel", "uniform", "vehicle"] as const).flatMap((kind) => {
      const chip = rosterFactChip(status, kind);
      return chip === "notOffered" ? [] : [{ kind, chip }];
    });
    return kinds.length > 0 ? [{ rosterEntryId: e.id, name: e.fullName, kinds }] : [];
  });
}
