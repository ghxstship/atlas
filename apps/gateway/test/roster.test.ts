import type { Engagement } from "@xos/data/gateway";
import type { MyRosterEntry, PendingInvitation } from "@xos/data/roster";
import { loadSitemapFile } from "@xos/ia/node";
import { describe, expect, it } from "vitest";
import { visibleEngagementTabs } from "../lib/engagement-offerings";
import { needsYou } from "../lib/home";
import { engagementRosterable, rosterConditions } from "../lib/roster";
import { navContext } from "../lib/shell/standing";

/**
 * The crew roster in Gateway (R4, ADR 0100 and 0101): the Crew tab shows to roster managers of a
 * rosterable engagement, after Advance (vendor, artist, the representative's Advance scope), after
 * Deliverables (contractor), after Onboarding (staff) and after the activation schedule (sponsor); Home
 * asks the person to answer invitations, memberships and roster entries first.
 */
const sitemap = loadSitemapFile(new URL("../ia/sitemap.yaml", import.meta.url));
const nav = navContext({
  standing: "individual",
  companyAccount: false,
  platformDomain: true,
  desktop: true,
});

const engagement = (over: Partial<Engagement>): Engagement => ({
  id: "e1",
  key: "ENG-1",
  orgId: "o1",
  orgName: "Northwind Live",
  projectId: "p1",
  projectName: "Summer Series",
  roleType: "Vendor",
  roleCode: "9000.50.02",
  jobTitle: "Audio",
  personId: null,
  accountId: "a1",
  payBasis: null,
  arrangement: null,
  rateMinor: null,
  rateCurrency: null,
  startDate: "2027-06-01",
  endDate: null,
  state: "Onboarding",
  areas: ["engagement", "documents", "onboarding", "roster"],
  projectTimeZone: "America/New_York",
  rosterLocksAt: null,
  ...over,
});

describe("roster manager", () => {
  it("rosters artists and company engagements of vendors, contractors, staff and sponsors, never clients", () => {
    expect(engagementRosterable({ roleType: "Artist", accountId: null })).toBe(true);
    for (const roleType of ["Vendor", "Contractor", "Staff", "Sponsor"] as const) {
      expect(engagementRosterable({ roleType, accountId: "a1" })).toBe(true);
      expect(engagementRosterable({ roleType, accountId: null })).toBe(false);
    }
    expect(engagementRosterable({ roleType: "Client", accountId: "a1" })).toBe(false);
    expect(engagementRosterable({ roleType: "Crew", accountId: null })).toBe(false);
  });

  it("needs the roster area open as well", () => {
    expect(rosterConditions(engagement({}))).toEqual(["roster-manager"]);
    expect(rosterConditions(engagement({ areas: ["engagement", "operational"] }))).toEqual([]);
    expect(rosterConditions(engagement({ roleType: "Client" }))).toEqual([]);
  });

  const tabs = (
    roleType: Parameters<typeof visibleEngagementTabs>[2],
    manager: boolean,
    scopes: string[] = [],
  ) => visibleEngagementTabs(sitemap, nav, roleType, scopes, manager ? ["roster-manager"] : []);
  const after = (list: string[], tab: string) => list[list.indexOf(tab) + 1];

  it("places Crew after Advance, Deliverables, Onboarding or the activation schedule, for managers only", () => {
    expect(after(tabs("vendor", true), "engagement.advance")).toBe("engagement.crew");
    expect(after(tabs("artist", true), "engagement.advance")).toBe("engagement.crew");
    expect(after(tabs("contractor", true), "engagement.deliverables")).toBe("engagement.crew");
    expect(after(tabs("staff", true), "engagement.onboarding")).toBe("engagement.crew");
    expect(after(tabs("sponsor", true), "engagement.activation-schedule")).toBe("engagement.crew");
    for (const roleType of ["vendor", "artist", "contractor", "staff", "sponsor"] as const) {
      expect(tabs(roleType, false)).not.toContain("engagement.crew");
    }
    expect(tabs("crew", true)).not.toContain("engagement.crew");
  });

  it("gives an artist's representative Crew within the Advance scope", () => {
    expect(tabs("artist-representative", true, ["advance"])).toContain("engagement.crew");
    expect(tabs("artist-representative", true, ["offers"])).not.toContain("engagement.crew");
  });
});

describe("Home asks for answers first", () => {
  const invitation: PendingInvitation = {
    kind: "roster",
    id: "i1",
    accountName: "Bayside Audio",
    orgName: "Northwind Live",
    projectName: "Summer Series",
    partyName: "Bayside Audio",
    jobTitle: "A2",
    accountRole: null,
    inviterName: "Victor Osei",
    expiresAt: "2027-06-01T00:00:00Z",
  };
  const entry = (over: Partial<MyRosterEntry>): MyRosterEntry => ({
    id: "r1",
    engagementId: "e1",
    projectId: "p1",
    orgName: "Northwind Live",
    projectName: "Summer Series",
    partyName: "Bayside Audio",
    roleType: "Vendor",
    jobTitle: null,
    arrivalStartsAt: null,
    arrivalEndsAt: null,
    arrivalTimeZone: null,
    entryState: "Draft",
    personResponse: "Pending",
    isSelf: false,
    shareCategories: [],
    ...over,
  });

  it("lists invitations, memberships to confirm and unanswered roster entries before anything else", () => {
    const items = needsYou({
      engagements: [],
      documents: [],
      onboarding: [],
      applications: [],
      representations: [],
      invitations: [invitation],
      memberships: [{ accountMembershipId: "m1", accountId: "a1", accountName: "Bayside Audio" }],
      rosterEntries: [
        entry({ id: "pending" }),
        entry({ id: "self", isSelf: true }),
        entry({ id: "answered", personResponse: "Accepted" }),
        entry({ id: "withdrawn", entryState: "Withdrawn" }),
      ],
      personId: "me",
      now: new Date("2027-05-01T12:00:00Z"),
    });
    expect(items.map((i) => i.kind)).toEqual(["invitation", "membership", "roster"]);
    expect(items[2]?.kind === "roster" && items[2].entry.id).toBe("pending");
  });

  it("adds nothing when the person has nothing to answer", () => {
    expect(
      needsYou({
        engagements: [],
        documents: [],
        onboarding: [],
        applications: [],
        representations: [],
        personId: "me",
        now: new Date("2027-05-01T12:00:00Z"),
      }),
    ).toEqual([]);
  });
});
