import type { Engagement, XosClient } from "@xos/data/gateway";
import type { EngagedAllocation, RosterEngagement } from "@xos/data/gateway-allocations";
import { loadSitemapFile } from "@xos/ia/node";
import { describe, expect, it } from "vitest";
import { visibleEngagementTabs } from "../lib/engagement-offerings";
import { pickUpNext, upNextDetails } from "../lib/home";
import {
  allocationTone,
  assignedToYou,
  engagementTabSet,
  parkingLines,
  resolveEngagement,
  rosterBring,
  rosterCall,
} from "../lib/roster-member";
import { navContext } from "../lib/shell/standing";

/**
 * A person on a party's roster in Gateway (R8, ADR 0100 roster-member): the engagement loads through
 * api_external.my_roster_engagements when the party read answers not-found, the Roster Member tabs
 * render, and the Overview's call, parking and what to bring come from their own rows only.
 */
const sitemap = loadSitemapFile(new URL("../ia/sitemap.yaml", import.meta.url));
const nav = navContext({
  standing: "account-member",
  companyAccount: true,
  platformDomain: true,
  desktop: true,
});

const ID = "01920000-0000-7000-8800-0000000000e1";

const engagement = (over: Partial<Engagement> = {}): Engagement => ({
  id: ID,
  key: "ENG-1",
  orgId: "o1",
  orgName: "Northwind Live",
  projectId: "p1",
  projectName: "Summer Series",
  roleType: "Vendor",
  roleCode: null,
  jobTitle: null,
  personId: "sam",
  accountId: "acct",
  payBasis: null,
  arrangement: null,
  rateMinor: null,
  rateCurrency: null,
  startDate: "2027-06-01",
  endDate: "2027-06-06",
  state: "Active",
  areas: ["onboarding", "operational", "roster"],
  projectTimeZone: "America/New_York",
  rosterLocksAt: null,
  ...over,
});

const rostered = (over: Partial<RosterEngagement> = {}): RosterEngagement => ({
  ...engagement(),
  rosterEntryId: "r1",
  entryRoleCode: "9000.50.02",
  arrivalStartsAt: "2027-06-01T12:00:00Z",
  arrivalEndsAt: "2027-06-01T14:00:00Z",
  arrivalTimeZone: "America/New_York",
  leadName: "Pia Larsen",
  ...over,
});

const allocation = (over: Partial<EngagedAllocation>): EngagedAllocation => ({
  id: "a",
  engagementId: ID,
  rosterEntryId: "r1",
  personName: "Kai Morgan",
  kind: "Asset",
  itemName: "Radios",
  quantity: 1,
  state: "Approved",
  status: "Reserved",
  reservedQuantity: 1,
  issuedQuantity: 0,
  returnedQuantity: 0,
  parentAllocationId: "pool",
  neededFrom: "2027-06-01T12:00:00Z",
  neededTo: "2027-06-05T12:00:00Z",
  neededTimeZone: "America/New_York",
  requestedByMe: false,
  declineReason: null,
  ...over,
});

/** A client whose api_external reads answer from a queue per view: `{ data, error }`. */
function viewClient(answers: Record<string, { data: unknown; error: unknown }[]>): XosClient {
  const query = (view: string) => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      maybeSingle: () => Promise.resolve(answers[view]?.shift() ?? { data: null, error: null }),
    };
    return builder;
  };
  return { schema: () => ({ from: query }) } as unknown as XosClient;
}

describe("standing to tab set", () => {
  it("opens the Roster Member tabs for a person reached only through the roster", () => {
    const set = engagementTabSet({ via: "roster", engagement: rostered() }, null);
    expect(set).toBe("roster-member");
    expect(
      visibleEngagementTabs(
        sitemap,
        nav,
        set,
        [],
        ["offered-travel-or-lodging", "offered-per-diem", "offered-project-facts"],
      ),
    ).toEqual([
      "engagement.overview",
      "engagement.project-details",
      "engagement.credentials",
      "engagement.travel-and-lodging",
      "engagement.per-diem",
      "engagement.documents",
      "engagement.messages",
    ]);
  });

  it("keeps the offering gate on travel, per diem and project details", () => {
    expect(visibleEngagementTabs(sitemap, nav, "roster-member", [], [])).toEqual([
      "engagement.overview",
      "engagement.credentials",
      "engagement.documents",
      "engagement.messages",
    ]);
  });

  it("never gives a person on the roster the party's tabs", () => {
    const tabs = visibleEngagementTabs(sitemap, nav, "roster-member", [], ["roster-manager"]);
    expect(tabs).not.toContain("engagement.crew");
    expect(tabs).not.toContain("engagement.invoices");
    expect(engagementTabSet({ via: "engagement", engagement: engagement() }, null)).toBe("vendor");
  });
});

const engagementRow = {
  id: ID,
  org_id: "o1",
  org_name: "Northwind Live",
  project_id: "p1",
  project_name: "Summer Series",
  role_type: "Vendor",
  role_code: null,
  job_title: null,
  person_id: "sam",
  account_id: "acct",
  pay_basis: null,
  arrangement: null,
  rate_minor: null,
  rate_currency_code: null,
  start_date: "2027-06-01",
  end_date: null,
  engagement_state: "Active",
  areas: ["operational", "roster"],
  project_time_zone: "America/New_York",
  roster_locks_at: null,
};
const rosterRow = {
  ...engagementRow,
  roster_entry_id: "r1",
  entry_role_code: null,
  arrival_window_start: null,
  arrival_window_end: null,
  arrival_time_zone: null,
  lead_name: "Pia Larsen",
};

describe("fallback load", () => {
  it("reads the party's engagement first", async () => {
    const db = viewClient({
      engagements: [{ data: engagementRow, error: null }],
      my_roster_engagements: [{ data: rosterRow, error: null }],
    });
    const result = await resolveEngagement(db, ID);
    expect(result.ok && result.data.via).toBe("engagement");
  });

  it("falls back to the roster engagement when the party read answers not-found", async () => {
    const db = viewClient({
      engagements: [{ data: null, error: null }],
      my_roster_engagements: [{ data: rosterRow, error: null }],
    });
    const result = await resolveEngagement(db, ID);
    expect(result.ok && result.data.via).toBe("roster");
    expect(result.ok && result.data.via === "roster" && result.data.engagement.rosterEntryId).toBe(
      "r1",
    );
  });

  it("answers not-found when neither read finds it, and passes any other failure on", async () => {
    const db = viewClient({
      engagements: [
        { data: null, error: null },
        { data: null, error: { code: "57014", message: "timeout" } },
      ],
      my_roster_engagements: [{ data: null, error: null }],
    });
    expect(await resolveEngagement(db, ID)).toEqual({ ok: false, error: { kind: "not-found" } });
    const failed = await resolveEngagement(db, ID);
    expect(!failed.ok && failed.error.kind).toBe("unexpected");
  });
});

describe("the Roster Member overview", () => {
  it("calls the person at their own shift today, else at the start of their arrival", () => {
    const e = rostered();
    expect(rosterCall({ engagement: e, shifts: [], today: "2027-06-01" })).toEqual({
      at: "2027-06-01T12:00:00Z",
      timeZone: "America/New_York",
      source: "arrival",
    });
    expect(
      rosterCall({
        engagement: e,
        shifts: [
          { startsAt: "2027-06-02T13:00:00Z", timeZone: "America/New_York" },
          { startsAt: "2027-06-01T11:00:00Z", timeZone: "America/New_York" },
        ],
        today: "2027-06-01",
      })?.source,
    ).toBe("shift");
    expect(
      rosterCall({
        engagement: rostered({ arrivalStartsAt: null }),
        shifts: [],
        today: "2027-06-01",
      }),
    ).toBeNull();
  });

  it("lists only the person's own rows and what to bring and pick up", () => {
    const rows = [
      allocation({ id: "radio", status: "Issued", issuedQuantity: 1 }),
      allocation({ id: "badge", kind: "Credential", itemName: "Crew", status: "Approved" }),
      allocation({ id: "requested", itemName: "Cart", state: "Requested", status: "Requested" }),
      allocation({ id: "gone", state: "Withdrawn", status: "Withdrawn" }),
      allocation({ id: "colleague", rosterEntryId: "r2", itemName: "Golf Cart" }),
      allocation({ id: "pool", rosterEntryId: null }),
    ];
    const mine = assignedToYou(rows, ["r1"]);
    expect(mine.map((a) => a.id)).toEqual(["radio", "badge", "requested"]);
    expect(rosterBring(mine)).toEqual(["Radios", "Crew"]);
    expect(allocationTone("Issued")).toBe("success");
    expect(allocationTone("Declined")).toBe("danger");
    expect(allocationTone("Requested")).toBe("accent");
    expect(allocationTone("On Order")).toBe("warning");
  });

  it("says parking by zones and vehicle, leaving revoked passes out", () => {
    const pass = {
      credentialId: "c1",
      projectId: "p1",
      credentialNumber: null,
      categoryName: "Crew Parking",
      validFrom: null,
      validTo: null,
      revokedAt: null,
      zoneCodes: ["LOT-A"],
      zoneNames: ["Lot A"],
      vehicleMake: "Ford",
      vehicleModel: "Transit",
      vehicleColor: "White",
    };
    expect(
      parkingLines([pass, { ...pass, credentialId: "c2", revokedAt: "2027-06-02T00:00:00Z" }]),
    ).toEqual(["Lot A · Ford Transit White"]);
  });
});

describe("Gateway Home for a person on a roster", () => {
  const now = new Date("2027-05-30T12:00:00Z");

  it("picks the roster engagement by its arrival window", () => {
    const own = engagement({ id: "own", startDate: "2027-06-03" });
    const roster = rostered();
    expect(pickUpNext([], [own], now, [roster])).toEqual({
      kind: "engagement",
      engagement: roster,
    });
    expect(pickUpNext([], [own], now, [])).toEqual({ kind: "engagement", engagement: own });
    const past = rostered({ arrivalEndsAt: "2027-05-29T00:00:00Z" });
    expect(pickUpNext([], [own], now, [past])).toEqual({ kind: "engagement", engagement: own });
  });

  it("adds parking and the party's lead to Up Next", () => {
    const details = upNextDetails({
      row: null,
      orgName: "Northwind Live",
      badges: [],
      gear: [],
      parking: [
        {
          credentialId: "c1",
          projectId: "p1",
          credentialNumber: null,
          categoryName: "Crew Parking",
          validFrom: null,
          validTo: null,
          revokedAt: null,
          zoneCodes: [],
          zoneNames: ["Lot A"],
          vehicleMake: "Ford",
          vehicleModel: null,
          vehicleColor: null,
        },
      ],
      lead: "Pia Larsen",
    });
    expect(details.parking).toEqual(["Lot A · Ford"]);
    expect(details.contact).toBe("Pia Larsen");
  });
});
