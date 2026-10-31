import type { RosterShiftCandidate, ShiftCandidate } from "@xos/data/crew";
import { describe, expect, it } from "vitest";
import { candidateKey, mergeCandidates } from "../lib/crew/board-candidates";

/** The drag board ranks members and agency staff in one list (R12 with A132). */

const member = (over: Partial<ShiftCandidate>): ShiftCandidate => ({
  membershipId: "m1",
  personId: "p1",
  name: "Dana Member",
  availability: "Unstated",
  overdue: false,
  conflict: false,
  workedRole: false,
  weekMinutes: 0,
  rank: 1,
  ...over,
});

const staff = (over: Partial<RosterShiftCandidate>): RosterShiftCandidate => ({
  rosterEntryId: "re1",
  engagementId: "eng",
  personId: "p9",
  name: "Stella Staff",
  accountName: "Crestline Staffing",
  availability: "Unstated",
  conflict: false,
  workedRole: false,
  trainingDue: 0,
  weekMinutes: 0,
  rank: 1,
  ...over,
});

describe("the drag board's ranking", () => {
  it("puts free people first, then those with no training due, then by availability", () => {
    const ranked = mergeCandidates(
      [
        member({ membershipId: "busy", name: "Busy", conflict: true, availability: "Available" }),
        member({ membershipId: "free", name: "Free", availability: "Tentative" }),
      ],
      [
        staff({ rosterEntryId: "avail", name: "Avail", availability: "Available" }),
        staff({ rosterEntryId: "due", name: "Due", availability: "Available", trainingDue: 1 }),
      ],
    );
    expect(ranked.map((c) => c.name)).toEqual(["Avail", "Free", "Due", "Busy"]);
    expect(ranked.map((c) => c.kind)).toEqual(["staff", "member", "staff", "member"]);
  });

  it("keys members and agency staff apart, even with the same id", () => {
    expect(candidateKey({ ...member({ membershipId: "x" }), kind: "member" })).not.toBe(
      candidateKey({ ...staff({ rosterEntryId: "x" }), kind: "staff" }),
    );
  });

  it("then prefers the role worked before and the fewest hours, then the name", () => {
    const ranked = mergeCandidates(
      [member({ membershipId: "a", name: "Zed", weekMinutes: 600 })],
      [
        staff({ rosterEntryId: "b", name: "Amy", weekMinutes: 600 }),
        staff({ rosterEntryId: "c", name: "Bo", workedRole: true, weekMinutes: 900 }),
      ],
    );
    expect(ranked.map((c) => c.name)).toEqual(["Bo", "Amy", "Zed"]);
  });
});
