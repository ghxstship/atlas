/**
 * A04P contract tests for the Gateway handlers: marketplace search and the external-party
 * resources. Requests run through `contractApp` against the in-memory client; every response is
 * checked against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/gateway.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const TIMES = {
  created_at: "2026-10-01T12:00:00.000Z",
  created_by: null,
  updated_at: "2026-10-01T12:00:00.000Z",
  updated_by: null,
};

function seed(component: string, rowId: string, extra: Row = {}): Row {
  return { ...sample(component, { id: rowId, ...TIMES, ...extra }), deleted_at: null };
}

function world(context = {}) {
  const db = memoryDb(
    {
      "api_external.opportunities": [
        {
          ...sample("MarketplaceListing", { id: id(8001), title: "Load-In Stagehands" }),
          venue_latitude: 25.7617,
          venue_longitude: -80.1918,
        },
        {
          ...sample("MarketplaceListing", { id: id(8002), title: "Spotlight Operator" }),
          opportunity_state: "Draft",
          venue_latitude: 25.7617,
          venue_longitude: -80.1918,
        },
        {
          ...sample("MarketplaceListing", { id: id(8003), title: "Orlando Riggers" }),
          venue_latitude: 28.5384,
          venue_longitude: -81.3789,
        },
        {
          ...sample("MarketplaceListing", { id: id(8004), title: "Unlocated Ushers" }),
          venue_latitude: null,
          venue_longitude: null,
        },
      ],
      saved_searches: [seed("SavedSearch", id(8101), { person_id: ME })],
      opportunity_alerts: [seed("OpportunityAlert", id(8102))],
      listing_reports: [seed("ListingReport", id(8103))],
      moderation_actions: [seed("ModerationAction", id(8104))],
      profile_shares: [
        {
          ...seed("ProfileShare", id(8105), { org_id: ORG, person_id: ME, revoked_at: null }),
          shared_fields: undefined,
        },
      ],
      profile_share_fields: [
        {
          id: id(8115),
          profile_share_id: id(8105),
          field_key: "phone",
          field_value: "+1 305 555 0100",
          deleted_at: null,
        },
      ],
      availability_calendars: [seed("AvailabilityCalendar", id(8106), { person_id: ME })],
      availability_blocks: [
        seed("AvailabilityBlock", id(8107), { availability_calendar_id: id(8106) }),
      ],
      engagement_threads: [seed("EngagementThread", id(8108), { org_id: ORG })],
      engagement_messages: [
        seed("EngagementMessage", id(8109), { org_id: ORG, engagement_thread_id: id(8108) }),
      ],
      tax_forms: [seed("TaxForm", id(8110), { org_id: ORG, tin_encrypted: "\\x00" })],
      payout_accounts: [seed("PayoutAccount", id(8111), { org_id: ORG })],
      background_checks: [seed("BackgroundCheck", id(8112), { org_id: ORG })],
    },
    {
      share_profile: (args, self) => {
        self.tables["profile_shares"]?.push({
          id: id(8125),
          org_id: args["p_org_id"],
          ...TIMES,
          person_id: ME,
          organization_id: args["p_account_id"] ?? null,
          engagement_id: args["p_engagement_id"] ?? null,
          shared_at: "2026-10-02T09:00:00.000Z",
          revoked_at: null,
          deleted_at: null,
        });
        (args["p_field_keys"] as string[]).forEach((key, i) =>
          self.tables["profile_share_fields"]?.push({
            id: id(8130 + i),
            profile_share_id: id(8125),
            field_key: key,
            field_value: (args["p_field_values"] as string[])[i],
            deleted_at: null,
          }),
        );
        return id(8125);
      },
      revoke_profile_share: (args, self) => {
        const row = self.tables["profile_shares"]?.find(
          (r) => r["id"] === args["p_profile_share_id"],
        );
        if (row) row["revoked_at"] = "2026-10-03T09:00:00.000Z";
        return null;
      },
      submit_tax_form: (args, self) => {
        self.tables["tax_forms"]?.push({
          id: id(8140),
          org_id: args["p_org_id"],
          ...TIMES,
          person_id: ME,
          organization_id: args["p_account_id"] ?? null,
          form_kind: args["p_form_kind"],
          tin_encrypted: "\\x01",
          tin_last4: String(args["p_tin"]).slice(-4),
          foreign_performer_withholding: args["p_foreign_performer_withholding"],
          signed_at: "2026-10-02T09:00:00.000Z",
          deleted_at: null,
        });
        return id(8140);
      },
    },
    {
      listing_reports: { reporter_person_id: ME, reported_at: "2026-10-02T09:00:00.000Z" },
      moderation_actions: { decided_at: "2026-10-02T09:00:00.000Z" },
      opportunity_alerts: { matched_at: "2026-10-02T09:00:00.000Z" },
      // The database derives org_id from the engagement (derive_org_id).
      engagement_threads: { org_id: ORG },
      engagement_messages: {
        org_id: ORG,
        author_person_id: ME,
        sent_at: "2026-10-02T09:00:00.000Z",
      },
      background_checks: { org_id: ORG, provider: "Checkr", result: "Pending", completed_at: null },
      saved_searches: { alerts_enabled: true },
      availability_calendars: { visibility: "Private" },
    },
  );
  const app = contractApp({ handlers: [handlers], db, context });
  return { db, http: requests(app) };
}

describe("marketplace search", () => {
  it("finds published listings by keyword", async () => {
    const { http } = world();
    const all = await http.get("/marketplace/opportunities");
    const page = (await expectContract(await success(all), "marketplace.search")) as {
      data: Row[];
    };
    expect(page.data.map((r) => r["id"]).sort()).toEqual([id(8001), id(8003), id(8004)]);
    expect(page.data.every((r) => r["distance_km"] === null)).toBe(true);
    expect(page.data.some((r) => "venue_latitude" in r)).toBe(false);
    const found = await http.get("/marketplace/opportunities?q=stage");
    const hits = (await expectContract(await success(found), "marketplace.search")) as {
      data: Row[];
    };
    expect(hits.data).toHaveLength(1);
  });

  it("measures distance from near and keeps listings without a located venue unmeasured", async () => {
    const { http } = world();
    const res = await http.get("/marketplace/opportunities?near=25.77,-80.19");
    const page = (await expectContract(await success(res), "marketplace.search")) as {
      data: Row[];
    };
    const byId = new Map(page.data.map((r) => [r["id"], r["distance_km"]]));
    expect(byId.get(id(8001))).toBeLessThan(2);
    expect(byId.get(id(8003))).toBeGreaterThan(300);
    expect(byId.get(id(8003))).toBeLessThan(340);
    expect(byId.get(id(8004))).toBeNull();
  });

  it("filters by radius and leaves out venues that are not located", async () => {
    const { http } = world();
    const near = await http.get("/marketplace/opportunities?near=25.77,-80.19&radius_km=10");
    const close = (await expectContract(await success(near), "marketplace.search")) as {
      data: Row[];
    };
    expect(close.data.map((r) => r["id"])).toEqual([id(8001)]);
    const wide = await http.get("/marketplace/opportunities?near=25.77,-80.19&radius_km=400");
    const both = (await expectContract(await success(wide), "marketplace.search")) as {
      data: Row[];
    };
    expect(both.data.map((r) => r["id"]).sort()).toEqual([id(8001), id(8003)]);
  });

  it("refuses a radius without a location and a location out of range", async () => {
    const { http } = world();
    const radiusOnly = await http.get("/marketplace/opportunities?radius_km=10");
    expect(radiusOnly.status).toBe(422);
    expect(await radiusOnly.json()).toMatchObject({ rule: "marketplace.radius_needs_near" });
    const outOfRange = await http.get("/marketplace/opportunities?near=95,-80.19&radius_km=10");
    expect(outOfRange.status).toBe(422);
    expect(await outOfRange.json()).toMatchObject({ rule: "marketplace.near_out_of_range" });
  });
});

describe("saved searches and alerts", () => {
  it("serves saved searches", async () => {
    const { http } = world();
    const listed = await http.get("/saved-searches");
    await expectContract(await success(listed), "savedSearches.list");
    const read = await http.get(`/saved-searches/${id(8101)}`);
    await expectContract(await success(read), "savedSearches.get");
    const made = await http.post("/saved-searches", { person_id: ME, name: "Riggers in Miami" });
    await expectContract(await success(made), "savedSearches.create");
    const edited = await http.patch(`/saved-searches/${id(8101)}`, { alerts_enabled: false });
    await expectContract(await success(edited), "savedSearches.update");
    const removed = await http.delete(`/saved-searches/${id(8101)}`);
    await expectContract(await success(removed), "savedSearches.delete");
  });

  it("serves opportunity alerts", async () => {
    const { http } = world();
    const listed = await http.get("/opportunity-alerts");
    await expectContract(await success(listed), "opportunityAlerts.list");
    const read = await http.get(`/opportunity-alerts/${id(8102)}`);
    await expectContract(await success(read), "opportunityAlerts.get");
  });
});

describe("listing reports and moderation", () => {
  it("reports a listing and records a moderation decision", async () => {
    const { http } = world();
    const reports = await http.get("/listing-reports");
    await expectContract(await success(reports), "listingReports.list");
    const report = await http.get(`/listing-reports/${id(8103)}`);
    await expectContract(await success(report), "listingReports.get");
    const filed = await http.post("/listing-reports", {
      reason: "Missing Pay Range",
      opportunity_id: id(8001),
    });
    const made = (await expectContract(await success(filed), "listingReports.create")) as Row;
    expect(made["reporter_person_id"]).toBe(ME);

    const actions = await http.get("/moderation-actions");
    await expectContract(await success(actions), "moderationActions.list");
    const action = await http.get(`/moderation-actions/${id(8104)}`);
    await expectContract(await success(action), "moderationActions.get");
  });
});

describe("profile shares", () => {
  it("shares a snapshot through app.share_profile and revokes it", async () => {
    const { db, http } = world();
    const listed = await http.get("/profile-shares");
    const page = (await expectContract(await success(listed), "profileShares.list")) as {
      data: Row[];
    };
    expect(page.data[0]?.["shared_fields"]).toEqual([
      { field_key: "phone", field_value: "+1 305 555 0100" },
    ]);
    const read = await http.get(`/profile-shares/${id(8105)}`);
    await expectContract(await success(read), "profileShares.get");
    const shared = await http.post("/profile-shares", {
      shared_fields: [{ field_key: "email", field_value: "crew@example.com" }],
    });
    const made = (await expectContract(await success(shared), "profileShares.create")) as Row;
    expect(made["shared_fields"]).toEqual([
      { field_key: "email", field_value: "crew@example.com" },
    ]);
    expect(db.calls[0]?.args["p_org_id"]).toBe(ORG);
    const revoked = await http.post(`/profile-shares/${id(8105)}/revoke`);
    const after = (await expectContract(await success(revoked), "profileShares.revoke")) as Row;
    expect(after["revoked_at"]).not.toBeNull();
    expect(db.calls.map((c) => c.name)).toEqual(["share_profile", "revoke_profile_share"]);
  });
});

describe("availability", () => {
  it("serves calendars and blocks", async () => {
    const { http } = world();
    const calendars = await http.get("/availability-calendars");
    await expectContract(await success(calendars), "availabilityCalendars.list");
    const calendar = await http.get(`/availability-calendars/${id(8106)}`);
    await expectContract(await success(calendar), "availabilityCalendars.get");
    const madeCalendar = await http.post("/availability-calendars", {
      person_id: ME,
      time_zone: "America/New_York",
    });
    await expectContract(await success(madeCalendar), "availabilityCalendars.create");
    const editedCalendar = await http.patch(`/availability-calendars/${id(8106)}`, {
      visibility: "Public",
    });
    await expectContract(await success(editedCalendar), "availabilityCalendars.update");

    const blocks = await http.get("/availability-blocks");
    await expectContract(await success(blocks), "availabilityBlocks.list");
    const block = await http.get(`/availability-blocks/${id(8107)}`);
    await expectContract(await success(block), "availabilityBlocks.get");
    const madeBlock = await http.post("/availability-blocks", {
      availability_calendar_id: id(8106),
      starts_at: "2027-03-10T09:00:00Z",
      ends_at: "2027-03-10T18:00:00Z",
      availability_kind: "Unavailable",
    });
    await expectContract(await success(madeBlock), "availabilityBlocks.create");
    const editedBlock = await http.patch(`/availability-blocks/${id(8107)}`, {
      availability_kind: "Tentative",
    });
    await expectContract(await success(editedBlock), "availabilityBlocks.update");
    const removedBlock = await http.delete(`/availability-blocks/${id(8107)}`);
    await expectContract(await success(removedBlock), "availabilityBlocks.delete");
    const removedCalendar = await http.delete(`/availability-calendars/${id(8106)}`);
    await expectContract(await success(removedCalendar), "availabilityCalendars.delete");
  });
});

describe("threads and messages", () => {
  it("opens a thread, renames it and posts a message", async () => {
    const { http } = world({ org: null });
    const threads = await http.get("/engagement-threads");
    await expectContract(await success(threads), "engagementThreads.list");
    const thread = await http.get(`/engagement-threads/${id(8108)}`);
    await expectContract(await success(thread), "engagementThreads.get");
    const opened = await http.post("/engagement-threads", {
      engagement_id: id(8201),
      subject: "Parking at the venue",
    });
    await expectContract(await success(opened), "engagementThreads.create");
    const renamed = await http.patch(`/engagement-threads/${id(8108)}`, { subject: "Load-in" });
    await expectContract(await success(renamed), "engagementThreads.update");

    const messages = await http.get(
      `/engagement-messages?filter[engagement_thread_id][eq]=${id(8108)}`,
    );
    await expectContract(await success(messages), "engagementMessages.list");
    const message = await http.get(`/engagement-messages/${id(8109)}`);
    await expectContract(await success(message), "engagementMessages.get");
    const posted = await http.post("/engagement-messages", {
      engagement_thread_id: id(8108),
      body: "Use the north gate.",
    });
    const made = (await expectContract(await success(posted), "engagementMessages.create")) as Row;
    expect(made["author_person_id"]).toBe(ME);
  });
});

describe("tax, payout and background checks", () => {
  it("submits a tax form through the secure path and reads only the last four", async () => {
    const { db, http } = world();
    const listed = await http.get("/tax-forms");
    await expectContract(await success(listed), "taxForms.list");
    const read = await http.get(`/tax-forms/${id(8110)}`);
    const form = (await expectContract(await success(read), "taxForms.get")) as Row;
    expect(form).not.toHaveProperty("tin_encrypted");
    const submitted = await http.post("/tax-forms", {
      form_kind: "W-9",
      tax_identifier: "123456789",
    });
    const made = (await expectContract(await success(submitted), "taxForms.create")) as Row;
    expect(made["tin_last4"]).toBe("6789");
    expect(db.calls[0]?.args["p_org_id"]).toBe(ORG);
    db.fail("rpc:submit_tax_form", refusal("tax_form_tin_invalid", "The identifier is not valid."));
    const refused = await http.post("/tax-forms", { form_kind: "W-9", tax_identifier: "12" });
    expect(refused.status).toBe(422);
  });

  it("adds and removes a payout account", async () => {
    const { db, http } = world();
    const listed = await http.get("/payout-accounts");
    await expectContract(await success(listed), "payoutAccounts.list");
    const read = await http.get(`/payout-accounts/${id(8111)}`);
    await expectContract(await success(read), "payoutAccounts.get");
    const added = await http.post("/payout-accounts", {
      provider: "Stripe Connect",
      provider_account_reference: "acct_1NvXyz",
    });
    const made = (await expectContract(await success(added), "payoutAccounts.create")) as Row;
    expect(made["person_id"]).toBe(ME);
    const removed = await http.delete(`/payout-accounts/${id(8111)}`);
    await expectContract(await success(removed), "payoutAccounts.delete");
    expect(db.writes.find((w) => w.op === "insert")?.values).toMatchObject({ org_id: ORG });
  });

  it("orders and reads background checks", async () => {
    const { http } = world();
    const listed = await http.get("/background-checks");
    await expectContract(await success(listed), "backgroundChecks.list");
    const read = await http.get(`/background-checks/${id(8112)}`);
    await expectContract(await success(read), "backgroundChecks.get");
    const ordered = await http.post("/background-checks", {
      engagement_id: id(8201),
      provider_reference: "chk_8812",
    });
    await expectContract(await success(ordered), "backgroundChecks.create");
  });
});
