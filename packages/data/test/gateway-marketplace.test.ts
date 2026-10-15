import { describe, expect, it } from "vitest";
import {
  acceptsApplications,
  applicationMode,
  applyToOpportunity,
  bidTotal,
  decideApplication,
  getOpportunity,
  listMyApplications,
  listMySavedSearches,
  removeSavedSearch,
  reportListing,
  setSavedSearchAlerts,
  saveSearch,
  searchOpportunities,
  submitBid,
  submitSlate,
  toDisplayKey,
  type ApplyInput,
} from "../src/gateway.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { gatewayClient } from "./gateway-client.ts";

const OPP = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f61";

const oppRow = {
  id: OPP,
  org_id: "o1",
  org_name: "Northwind Live",
  title: "A2 Audio Technician",
  description: "Three-day festival call.",
  role_type: "Crew",
  role_code: "5000.01.01-A2",
  cat_urid: "5000.01.01",
  venue_name: "Harbor Pavilion",
  jurisdiction_id: "US-FL-MIAMI-DADE",
  starts_on: "2026-11-01",
  ends_on: "2026-11-03",
  visibility: "Public",
  rate_type: null,
  pay_min_minor: null,
  pay_max_minor: null,
  currency_code: null,
  rate_on_request: null,
  deadline_at: "2026-10-30T00:00:00Z",
  minimum_age: 18,
  opportunity_state: "Published",
  position_count: null,
};

describe("search", () => {
  it("searches published opportunities with filters", async () => {
    const { db, calls } = gatewayClient({
      "from:api_external.opportunities": [okResponse([oppRow]), errorResponse("08000", "down")],
    });
    const result = await searchOpportunities(db, {
      query: "audio, (A2)",
      roleTypes: ["Crew"],
      startsAfter: "2026-10-15",
      endsBefore: "2026-12-31",
      minPayMinor: 30000,
      orgId: "o1",
      orgName: "Northwind Live",
      limit: 10,
    });
    expect(result.ok && result.data[0]).toMatchObject({
      key: toDisplayKey("opportunity", OPP),
      rateOnRequest: true,
      positionCount: 0,
    });
    const steps = calls[0]?.steps ?? [];
    expect(steps).toContainEqual(["eq", ["opportunity_state", "Published"]]);
    expect(steps).toContainEqual([
      "or",
      ["title.ilike.*audio   A2*,description.ilike.*audio   A2*"],
    ]);
    expect(steps).toContainEqual(["in", ["role_type", ["Crew"]]]);
    expect(steps).toContainEqual(["eq", ["org_id", "o1"]]);
    expect(steps).toContainEqual(["limit", [10]]);
    expect((await searchOpportunities(db)).ok).toBe(false);
  });

  it("reads one opportunity with positions, questions and requirements", async () => {
    const { db } = gatewayClient({
      "from:api_external.opportunities": [
        okResponse(oppRow),
        okResponse(null),
        errorResponse("08000", "down"),
      ],
      "from:api_external.opportunity_positions": [
        okResponse([{ id: "pp1", opportunity_id: OPP, label: "A2", call_at: null, ends_at: null }]),
        okResponse([]),
        okResponse([]),
      ],
      "from:api_external.opportunity_questions": [
        okResponse([
          {
            id: "q1",
            opportunity_id: OPP,
            prompt: "Console experience?",
            sort_order: 1,
            is_required: null,
          },
        ]),
        okResponse([]),
        okResponse([]),
      ],
      "from:api_external.opportunity_requirements": [
        okResponse([
          {
            id: "r1",
            opportunity_id: OPP,
            requirement_kind: "Certification",
            description: null,
            certification_name: "OSHA 10",
            insurance_minimum_minor: null,
            currency_code: null,
          },
        ]),
        okResponse([]),
        okResponse([]),
      ],
    });
    const detail = await getOpportunity(db, OPP);
    expect(detail.ok && detail.data.positions[0]?.label).toBe("A2");
    expect(detail.ok && detail.data.questions[0]?.required).toBe(false);
    expect(detail.ok && detail.data.requirements[0]?.certificationName).toBe("OSHA 10");
    expect(await getOpportunity(db, OPP)).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getOpportunity(db, OPP)).ok).toBe(false);
  });

  it("knows when applications close and how each role type applies", () => {
    const now = new Date("2026-10-14T00:00:00Z");
    expect(acceptsApplications({ state: "Published", deadlineAt: null }, now)).toBe(true);
    expect(acceptsApplications({ state: "Published", deadlineAt: "2026-10-01" }, now)).toBe(false);
    expect(acceptsApplications({ state: "Filled", deadlineAt: null }, now)).toBe(false);
    expect(applicationMode("Vendor", null, true)).toBe("bid");
    expect(applicationMode("Contractor", "Bid", false)).toBe("bid");
    expect(applicationMode("Artist", "Flat", false)).toBe("artist");
    expect(applicationMode("Staff", "Hourly", true)).toBe("slate");
    expect(applicationMode("Staff", "Hourly", false)).toBe("person");
  });
});

describe("applications", () => {
  const appRow = (id: string) => ({
    id,
    opportunity_id: OPP,
    applicant_person_id: "me",
    applicant_organization_id: null,
    submitted_by: "me",
    availability_confirmed: true,
    cover_note: null,
    proposed_fee_minor: null,
    currency_code: null,
    application_state: "Offered",
    submitted_at: "2026-10-10T00:00:00Z",
  });
  const A1 = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f62";
  const A2 = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f63";

  it("lists applications with their opportunity, interviews and own bid", async () => {
    const { db } = gatewayClient({
      "from:api_external.applications": [
        okResponse([appRow(A1), appRow(A2)]),
        okResponse([]),
        errorResponse("08000", "down"),
        okResponse([appRow(A1)]),
        okResponse([appRow(A1)]),
      ],
      "from:api_external.opportunities": [
        okResponse([oppRow]),
        errorResponse("08000", "down"),
        okResponse([]),
      ],
      "from:api_external.interviews": [
        okResponse([
          {
            id: "i1",
            application_id: A1,
            interview_kind: "Audition",
            scheduled_at: "2026-10-20T15:00:00Z",
            duration_minutes: 30,
            location_text: "Studio B",
          },
        ]),
        okResponse([]),
        okResponse([]),
      ],
      "from:api_external.bids": [
        okResponse([
          {
            id: "b1",
            application_id: A2,
            currency_code: "USD",
            valid_until: null,
            submitted_at: "x",
          },
        ]),
        okResponse([]),
        okResponse([
          {
            id: "b2",
            application_id: A1,
            currency_code: "USD",
            valid_until: null,
            submitted_at: "x",
          },
        ]),
      ],
      "from:api_external.bid_lines": [
        okResponse([
          {
            id: "l1",
            bid_id: "b1",
            description: "Line array",
            element_id: null,
            quantity: 2,
            unit_price_minor: 5000,
          },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    const listed = await listMyApplications(db);
    expect(listed.ok && listed.data[0]?.interviews[0]?.kind).toBe("Audition");
    expect(listed.ok && listed.data[1]?.bid?.lines[0]?.unitPriceMinor).toBe(5000);
    expect(listed.ok && listed.data[0]?.opportunity?.title).toBe("A2 Audio Technician");
    expect(await listMyApplications(db)).toEqual({ ok: true, data: [] });
    expect((await listMyApplications(db)).ok).toBe(false);
    expect((await listMyApplications(db)).ok).toBe(false);
    expect((await listMyApplications(db)).ok).toBe(false);
  });

  it("decides offers and withdraws through transition_application", async () => {
    const { db, calls } = gatewayClient({
      "rpc:transition_application": [
        okResponse("t"),
        errorResponse("XR001", "lifecycle_conflict: Moved."),
      ],
    });
    const input = {
      applicationId: A1,
      expected: "Offered" as const,
      next: "Accepted" as const,
      reason: "Accepted.",
    };
    expect((await decideApplication(db, input)).ok).toBe(true);
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_application_id: A1, p_expected: "Offered", p_next: "Accepted", p_reason: "Accepted." }],
    ]);
    expect((await decideApplication(db, input)).ok).toBe(false);
  });

  it("applies with answers, skipping blank ones", async () => {
    const input: ApplyInput = {
      opportunityId: OPP,
      applicantPersonId: "me",
      applicantOrganizationId: null,
      profileShareId: "s1",
      availabilityConfirmed: true,
      coverNote: null,
      proposedFeeMinor: null,
      currency: "USD",
      answers: [
        { questionId: "q1", text: " Yes, DiGiCo " },
        { questionId: "q2", text: "  " },
      ],
    };
    const { db, calls } = gatewayClient({
      "from:applications": [
        okResponse({ id: "a1" }),
        okResponse({ id: "a2" }),
        errorResponse("XR001", "application_deadline_passed: Closed."),
        okResponse({ id: "a3" }),
      ],
      "from:application_answers": [okResponse(null), errorResponse("23514", "long")],
    });
    expect(await applyToOpportunity(db, input)).toEqual({
      ok: true,
      data: { applicationId: "a1" },
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      expect.objectContaining({ currency_code: null, profile_share_id: "s1" }),
    ]);
    expect(calls[1]?.steps[0]).toEqual([
      "insert",
      [[{ application_id: "a1", opportunity_question_id: "q1", answer_text: "Yes, DiGiCo" }]],
    ]);
    expect(await applyToOpportunity(db, { ...input, answers: [] })).toEqual({
      ok: true,
      data: { applicationId: "a2" },
    });
    const refused = await applyToOpportunity(db, input);
    expect(!refused.ok && refused.error.kind).toBe("refusal");
    expect((await applyToOpportunity(db, { ...input, proposedFeeMinor: 50000 })).ok).toBe(false);
  });

  it("submits sealed bids and agency slates", async () => {
    const { db } = gatewayClient({
      "from:bids": [
        okResponse({ id: "b1" }),
        okResponse({ id: "b2" }),
        errorResponse("42501", "no"),
        okResponse({ id: "b3" }),
      ],
      "from:bid_lines": [okResponse(null), errorResponse("23514", "qty")],
      "from:agency_slates": [
        okResponse(null),
        errorResponse("XR001", "slate_member: Not in account."),
      ],
    });
    const bid = {
      applicationId: "a1",
      currency: "USD",
      validUntil: null,
      lines: [{ description: " Truss ", quantity: 4, unitPriceMinor: null }],
    };
    expect(await submitBid(db, bid)).toEqual({ ok: true, data: { bidId: "b1" } });
    expect((await submitBid(db, { ...bid, lines: [] })).ok).toBe(true);
    expect((await submitBid(db, bid)).ok).toBe(false);
    expect((await submitBid(db, bid)).ok).toBe(false);
    expect(await submitSlate(db, { applicationId: "a1", personIds: [] })).toEqual({
      ok: true,
      data: null,
    });
    expect((await submitSlate(db, { applicationId: "a1", personIds: ["p1"] })).ok).toBe(true);
    expect((await submitSlate(db, { applicationId: "a1", personIds: ["p1"] })).ok).toBe(false);
  });

  it("totals bids and keeps unpriced lines blank", () => {
    expect(
      bidTotal([
        { quantity: 2, unitPriceMinor: 500 },
        { quantity: 1, unitPriceMinor: 250 },
      ]),
    ).toBe(1250);
    expect(
      bidTotal([
        { quantity: 2, unitPriceMinor: 500 },
        { quantity: 1, unitPriceMinor: null },
      ]),
    ).toBeNull();
  });
});

describe("saved searches and reports", () => {
  it("saves a search and reports a listing", async () => {
    const { db, calls } = gatewayClient({
      "from:saved_searches": [okResponse({ id: "ss1" }), errorResponse("23514", "name")],
      "from:listing_reports": [okResponse(null), errorResponse("42501", "no")],
    });
    const search = {
      personId: "me",
      name: " Audio in Miami ",
      roleType: "Crew" as const,
      startsAfter: null,
      endsBefore: null,
      orgId: null,
    };
    expect(await saveSearch(db, search)).toEqual({ ok: true, data: { savedSearchId: "ss1" } });
    expect((await saveSearch(db, search)).ok).toBe(false);
    expect(
      (await reportListing(db, { opportunityId: OPP, reason: "Fraud", details: " Fake " })).ok,
    ).toBe(true);
    expect(calls[2]?.steps[0]).toEqual([
      "insert",
      [{ opportunity_id: OPP, reason: "Fraud", details: "Fake" }],
    ]);
    expect(
      (await reportListing(db, { opportunityId: OPP, reason: "Fraud", details: null })).ok,
    ).toBe(false);
  });
});

describe("saved search management", () => {
  it("lists, toggles and removes saved searches", async () => {
    const { db } = gatewayClient({
      "from:api_external.my_saved_searches": [
        okResponse([
          {
            id: "s1",
            name: "Audio",
            role_type: "Crew",
            starts_after: null,
            ends_before: null,
            alerts_enabled: true,
          },
        ]),
        errorResponse("08000", "down"),
      ],
      "from:saved_searches": [
        okResponse(null),
        errorResponse("42501", "no"),
        okResponse(null),
        errorResponse("42501", "no"),
      ],
    });
    const listed = await listMySavedSearches(db);
    expect(listed.ok && listed.data[0]?.alertsEnabled).toBe(true);
    expect((await listMySavedSearches(db)).ok).toBe(false);
    expect((await setSavedSearchAlerts(db, { id: "s1", enabled: false })).ok).toBe(true);
    expect((await setSavedSearchAlerts(db, { id: "s1", enabled: true })).ok).toBe(false);
    expect((await removeSavedSearch(db, "s1")).ok).toBe(true);
    expect((await removeSavedSearch(db, "s1")).ok).toBe(false);
  });
});
