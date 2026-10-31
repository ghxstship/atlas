import type { RosterEntry } from "@xos/data/roster";
import { describe, expect, it } from "vitest";
import {
  crewBulkConfig,
  groupByParty,
  ROSTER_RECORD_STATE,
  visibleRosterRows,
} from "@/lib/advancing/crew-roster";

/**
 * The crew roster section of Advancing (R4): rows grouped by party, withdrawn entries hidden unless
 * asked for, and the bulk bar a reviewer gets: Accept or Return, asking one reason, through
 * app.bulk_update_roster_entries.
 */
const entry = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  id,
  projectId: "p1",
  engagementId: "e1",
  partyName: "Bayside Audio",
  roleType: "Vendor",
  isSelf: false,
  personId: id,
  fullName: id,
  invitedEmail: null,
  invitationExpiresAt: null,
  roleCode: null,
  jobTitle: null,
  arrivalStartsAt: null,
  arrivalEndsAt: null,
  arrivalTimeZone: null,
  entryState: "Submitted",
  personResponse: "Pending",
  respondedAt: null,
  returnReason: null,
  replacesEntryId: null,
  shareCategories: [],
  ...over,
});

describe("crew roster", () => {
  it("hides withdrawn entries unless the filter asks for them", () => {
    const rows = [entry("a"), entry("b", { entryState: "Withdrawn" })];
    expect(visibleRosterRows(rows, undefined).map((r) => r.id)).toEqual(["a"]);
    expect(visibleRosterRows(rows, "Withdrawn").map((r) => r.id)).toEqual(["b"]);
  });

  it("groups by party in name order, keeping each party's order", () => {
    const groups = groupByParty([
      entry("a", { partyName: "Lumen Artists" }),
      entry("b"),
      entry("c", { partyName: "Lumen Artists" }),
    ]);
    expect(groups.map((g) => [g.party, g.rows.map((r) => r.id)])).toEqual([
      ["Bayside Audio", ["b"]],
      ["Lumen Artists", ["a", "c"]],
    ]);
  });

  it("gives a reviewer the bulk bar with Accept and Return and one reason, and nobody else", () => {
    const labels = { state: "Entry state", accept: "Accept", return: "Return" };
    expect(crewBulkConfig("nwl", false, labels)).toBeNull();
    const config = crewBulkConfig("nwl", true, labels);
    expect(config?.resource).toBe("engagement_roster_entries");
    expect(config?.fields).toEqual([
      {
        key: "entry_state",
        label: "Entry state",
        reason: true,
        options: [
          { value: "Accepted", label: "Accept" },
          { value: "Returned", label: "Return" },
        ],
      },
    ]);
  });

  it("shows a returned entry as blocked and a submitted one as in review", () => {
    expect(ROSTER_RECORD_STATE.Returned).toBe("blocked");
    expect(ROSTER_RECORD_STATE.Submitted).toBe("in-review");
  });
});
