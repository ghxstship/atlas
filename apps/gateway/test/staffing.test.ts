import type { RosterEngagement } from "@xos/data/gateway-allocations";
import { loadSitemapFile } from "@xos/ia/node";
import { describe, expect, it } from "vitest";
import { KNOWN_REFUSALS } from "../lib/action-result";
import { visibleEngagementTabs } from "../lib/engagement-offerings";
import { engagementTabSet, onRoster } from "../lib/roster-member";
import { navContext } from "../lib/shell/standing";
import en from "../../../packages/i18n/messages/en-US/gateway.json";
import es from "../../../packages/i18n/messages/es-US/gateway.json";

/**
 * Agency staff in Gateway (R12, ADR 0100 amendment): a person on a staffing agency's roster gets the roster-staff
 * tabs, with Training, Shifts and Timesheets beside the Roster Member ones; the placement refusals have copy.
 */
const sitemap = loadSitemapFile(new URL("../ia/sitemap.yaml", import.meta.url));
const nav = navContext({
  standing: "individual",
  companyAccount: false,
  platformDomain: true,
  desktop: true,
});

const rostered = (over: Partial<RosterEngagement>): RosterEngagement => ({
  id: "e1",
  key: "ENG-1",
  orgId: "o1",
  orgName: "Northwind Live",
  projectId: "p1",
  projectName: "Summer Series",
  roleType: "Staff",
  roleCode: "5000.51.02",
  jobTitle: "Event Staff",
  personId: null,
  accountId: "a1",
  payBasis: null,
  arrangement: null,
  rateMinor: null,
  rateCurrency: null,
  startDate: "2027-06-01",
  endDate: null,
  state: "Active",
  areas: ["engagement", "operational", "onboarding"],
  projectTimeZone: "America/New_York",
  rosterLocksAt: null,
  rosterEntryId: "re1",
  entryRoleCode: null,
  arrivalStartsAt: null,
  arrivalEndsAt: null,
  arrivalTimeZone: null,
  leadName: null,
  ...over,
});

describe("roster-staff tab set", () => {
  it("opens for a person on a staffing agency's roster, and roster-member for any other roster", () => {
    expect(engagementTabSet({ via: "roster", engagement: rostered({}) }, null)).toBe(
      "roster-staff",
    );
    expect(
      engagementTabSet({ via: "roster", engagement: rostered({ roleType: "Vendor" }) }, null),
    ).toBe("roster-member");
    expect(onRoster({ roleType: "roster-staff" })).toBe(true);
    expect(onRoster({ roleType: "roster-member" })).toBe(true);
    expect(onRoster({ roleType: "staff" })).toBe(false);
  });

  it("shows training, shifts and timesheets, and never the party's tabs", () => {
    const tabs = visibleEngagementTabs(sitemap, nav, "roster-staff", [], []);
    expect(tabs).toEqual([
      "engagement.overview",
      "engagement.training",
      "engagement.shifts",
      "engagement.timesheets",
      "engagement.credentials",
      "engagement.documents",
      "engagement.messages",
    ]);
    const managed = visibleEngagementTabs(sitemap, nav, "roster-staff", [], ["roster-manager"]);
    expect(managed).not.toContain("engagement.crew");
    expect(managed).not.toContain("engagement.positions");
    expect(managed).not.toContain("engagement.invoices");
  });
});

describe("placement refusals", () => {
  const rules = [
    "roster_shift_not_agency_slot",
    "roster_entry_other_engagement",
    "roster_entry_not_accepted",
    "roster_training_incomplete",
    "roster_shift_overlap",
    "roster_shift_closed",
    "roster_entry_not_working",
    "sod_roster_training",
  ];
  it("are known refusals with copy in both locales", () => {
    for (const rule of rules) {
      expect(KNOWN_REFUSALS as readonly string[]).toContain(rule);
      expect((en.outcomes.refusals as Record<string, string>)[rule]).toBeTruthy();
      expect((es.outcomes.refusals as Record<string, string>)[rule]).toBeTruthy();
    }
  });

  it("place with one field and one action", () => {
    expect(Object.keys(en.engagement.forms.staffing)).toEqual([
      "assign",
      "assigned",
      "assignTitle",
      "person",
      "personHint",
    ]);
  });
});
