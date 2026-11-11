import type { Engagement } from "@xos/data/gateway";
import type { Condition } from "@xos/ia";
import type { RosterEntry } from "@xos/data/roster";

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
