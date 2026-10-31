import { describe, expect, it } from "vitest";
import {
  activeAirportCodes,
  applyContractIntake,
  applyDraftedAdvanceAnswer,
  applyItineraryIntake,
  bookedItinerarySegments,
  closeIntake,
  draftableAdvanceSections,
  getIntake,
  intakePartyCandidates,
  itineraryTravelerCandidates,
  listDraftSources,
  readsPayroll,
  saveDraftDocument,
  startIntake,
  vendorLineHistory,
} from "../src/ai.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

describe("intake batches (B15)", () => {
  it("starts a batch with the fulfillment only when given, and keeps the refusal rule", async () => {
    const { db, calls } = fakeClient({
      "rpc:start_ai_intake": [
        okResponse("b1"),
        okResponse("b2"),
        errorResponse(
          "XR001",
          "plan_limit_exceeded: The plan allows 10000 aurora_requests_per_month; this change needs 10004.",
          "plan_limit_exceeded",
        ),
      ],
    });
    expect(
      await startIntake(db, {
        projectId: "p1",
        kind: "Itineraries",
        fileCount: 3,
        fulfillmentId: "f1",
      }),
    ).toEqual({
      ok: true,
      data: "b1",
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { p_project_id: "p1", p_kind: "Itineraries", p_file_count: 3, p_fulfillment_id: "f1" },
    ]);
    await startIntake(db, { projectId: "p1", kind: "Contracts and Riders", fileCount: 2 });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      { p_project_id: "p1", p_kind: "Contracts and Riders", p_file_count: 2 },
    ]);
    expect(
      await startIntake(db, { projectId: "p1", kind: "Itineraries", fileCount: 4 }),
    ).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "plan_limit_exceeded" },
    });
  });

  it("reads a batch with its requests and Proposed suggestions, and is not found for someone else", async () => {
    const batch = {
      id: "b1",
      project_id: "p1",
      intake_kind: "Itineraries",
      fulfillment_id: null,
      file_count: 2,
      closed_at: null,
      created_by: "me",
    };
    const { db, calls } = fakeClient({
      "from:ai_intake_batches": [okResponse(batch), okResponse(null)],
      "from:ai_requests": [
        okResponse([
          { id: "r1", outcome: "Answered", failure_code: null, created_at: "2026-10-30T00:00:00Z" },
        ]),
      ],
      "from:ai_suggestions": [
        okResponse([
          {
            id: "s1",
            request_id: "r1",
            operation_id: "aurora.applyItineraries",
            target_id: null,
            summary: "Add a segment.",
            suggestion_state: "Proposed",
            expires_at: "2026-11-06T00:00:00Z",
            applied_id: null,
          },
        ]),
      ],
      "from:ai_suggestion_fields": [
        okResponse([
          {
            suggestion_id: "s1",
            field_path: "departs_from",
            proposed_value: "MIA",
            confidence: "0.900",
            refusal: null,
            missing: null,
            source_excerpt: "MIA 08:15",
            position: 0,
          },
        ]),
      ],
    });
    const result = await getIntake(db, "b1");
    expect(result).toMatchObject({
      ok: true,
      data: {
        id: "b1",
        requests: [{ id: "r1", outcome: "Answered" }],
        suggestions: [
          {
            id: "s1",
            proposed_fields: [{ field_path: "departs_from", confidence: 0.9, provenance: "agent" }],
          },
        ],
      },
    });
    expect(calls.find((c) => c.target === "from:ai_suggestions")?.steps).toContainEqual([
      "eq",
      ["suggestion_state", "Proposed"],
    ]);
    expect(await getIntake(db, "b9")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("closes a batch and applies itineraries and contracts, mapping value errors to invalid", async () => {
    const { db, calls } = fakeClient({
      "rpc:close_ai_intake": [okResponse(3)],
      "rpc:apply_itinerary_intake": [
        okResponse({ written: [{ suggestion_id: "s1", id: "t1" }], rejected: 1 }),
        errorResponse(
          "XR001",
          "itinerary_duplicate: Item 2 is already booked for this traveler.",
          "itinerary_duplicate",
        ),
        errorResponse(
          "22007",
          'Item 1: invalid input syntax for type timestamp with time zone: "8am"',
        ),
      ],
      "rpc:apply_contract_intake": [
        okResponse({
          applied: [{ suggestion_id: "c1", id: "e1" }],
          engagements: 1,
          riders: 1,
          rider_lines: 2,
          rejected: 0,
        }),
        errorResponse(
          "XR001",
          "intake_fee_restricted: Act 1: only someone who may see pay rates sets a fee.",
          "intake_fee_restricted",
        ),
      ],
    });
    expect(await closeIntake(db, "b1")).toEqual({ ok: true, data: 3 });
    expect(
      await applyItineraryIntake(db, "b1", [{ suggestion_id: "s1", values: { person_id: "p" } }]),
    ).toEqual({
      ok: true,
      data: { written: [{ suggestion_id: "s1", id: "t1" }], rejected: 1 },
    });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      { p_batch_id: "b1", p_items: [{ suggestion_id: "s1", values: { person_id: "p" } }] },
    ]);
    expect(await applyItineraryIntake(db, "b1", [])).toMatchObject({
      error: { kind: "refusal", rule: "itinerary_duplicate" },
    });
    expect(await applyItineraryIntake(db, "b1", [])).toMatchObject({ error: { kind: "invalid" } });
    expect(await applyContractIntake(db, "b1", [])).toEqual({
      ok: true,
      data: {
        applied: [{ suggestion_id: "c1", id: "e1" }],
        engagements: 1,
        riders: 1,
        rider_lines: 2,
        rejected: 0,
      },
    });
    expect(await applyContractIntake(db, "b1", [])).toMatchObject({
      error: { kind: "refusal", rule: "intake_fee_restricted" },
    });
  });

  it("reads candidates and history without a call when there is nothing to look up", async () => {
    const { db, calls } = fakeClient({
      "rpc:itinerary_traveler_candidates": [
        okResponse([
          {
            name_index: 1,
            person_id: "ivy",
            full_name: "Ivy Marchetti",
            roster_entry_id: null,
            engagement_id: "e1",
            similarity: "1.000",
          },
        ]),
      ],
      "rpc:intake_party_candidates": [
        okResponse([
          {
            name_index: 1,
            candidate_kind: "engagement",
            candidate_id: "e2",
            name: "Arturo Bell",
            similarity: "0.950",
            engagement_id: "e2",
            already_booked: true,
          },
        ]),
      ],
      "rpc:vendor_line_history": [
        okResponse([
          {
            description_index: 1,
            source: "invoice",
            reference: "INV-0042",
            line_number: 1,
            issued_on: "2027-05-01",
            description: "Wedge monitor rental",
            quantity: "4",
            unit_price_minor: 4500,
            currency_code: "USD",
            similarity: "1.000",
          },
        ]),
      ],
    });
    expect(await itineraryTravelerCandidates(db, "b1", [])).toEqual({ ok: true, data: [] });
    expect(await itineraryTravelerCandidates(db, "b1", ["Ivy"])).toMatchObject({
      ok: true,
      data: [{ person_id: "ivy", similarity: 1 }],
    });
    expect(await intakePartyCandidates(db, "b1", ["Arturo Bell"])).toMatchObject({
      ok: true,
      data: [{ already_booked: true, similarity: 0.95 }],
    });
    expect(await vendorLineHistory(db, "i1", ["Wedge"])).toMatchObject({
      ok: true,
      data: [{ quantity: 4, unit_price_minor: 4500 }],
    });
    expect(await vendorLineHistory(db, "i1", [])).toEqual({ ok: true, data: [] });
    expect(calls).toHaveLength(3);
  });
});

describe("drafted advance answers (B15)", () => {
  it("reads draftable sections and records an answer with its source", async () => {
    const sections = {
      recipient_id: "r1",
      packet_id: "k1",
      project_id: "p1",
      time_zone: "America/New_York",
      engagement_id: null,
      sections: [],
      roster: [],
    };
    const { db, calls } = fakeClient({
      "rpc:draftable_advance_sections": [okResponse(sections)],
      "rpc:apply_drafted_advance_answer": [
        okResponse("sub1"),
        errorResponse(
          "XR001",
          "advance_answer_pending: This section is answered; answer again only after it is returned.",
          "advance_answer_pending",
        ),
      ],
    });
    expect(await draftableAdvanceSections(db, "r1")).toEqual({ ok: true, data: sections });
    expect(
      await applyDraftedAdvanceAnswer(db, {
        suggestionId: "s1",
        source: { inbound_message_id: "m1" },
      }),
    ).toEqual({ ok: true, data: "sub1" });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      { p_suggestion_id: "s1", p_values: {}, p_source: { inbound_message_id: "m1" } },
    ]);
    expect(
      await applyDraftedAdvanceAnswer(db, {
        suggestionId: "s1",
        values: { body: "x" },
        source: { file_name: "a.pdf" },
      }),
    ).toMatchObject({
      error: { kind: "refusal", rule: "advance_answer_pending" },
    });
  });

  it("finds the preview rows the traveler already has, in the caller's session", async () => {
    const { db, calls } = fakeClient({
      "from:travel_segments": [
        okResponse([
          {
            person_id: "p2",
            service_identifier: " ga 101 ",
            departs_at: "2027-06-02T08:15:00+00:00",
          },
          {
            person_id: "p1",
            service_identifier: "GA 100",
            departs_at: "2027-06-09T12:15:00+00:00",
          },
        ]),
      ],
    });
    const rows = [
      { person_id: "p1", service_identifier: "GA 100", departs_at: "2027-06-01T12:15:00Z" },
      { person_id: "p2", service_identifier: "GA 101", departs_at: "2027-06-02T04:15:00-04:00" },
      { person_id: "p3", service_identifier: null, departs_at: "2027-06-02T04:15:00Z" },
      { person_id: "p3", service_identifier: "GA 102", departs_at: null },
    ];
    expect(await bookedItinerarySegments(db, "o1", rows)).toEqual({ ok: true, data: [2] });
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "o1"]]);
    expect(calls[0]?.steps).toContainEqual(["in", ["person_id", ["p1", "p2"]]]);
    expect(calls[0]?.steps).toContainEqual([
      "in",
      ["departs_at", ["2027-06-01T12:15:00.000Z", "2027-06-02T08:15:00.000Z"]],
    ]);
    // Nothing to check reads nothing.
    expect(await bookedItinerarySegments(db, "o1", [rows[2] as never])).toEqual({
      ok: true,
      data: [],
    });
    expect(calls).toHaveLength(1);
  });

  it("asks the database whether the caller reads pay rates, and which airports are active", async () => {
    const { db, calls } = fakeClient({
      "rpc:my_capabilities_on_project": [
        okResponse(["data.restricted.read.payroll"]),
        okResponse([]),
      ],
      "from:airports": [okResponse([{ iata_code: "MIA" }])],
    });
    expect(await readsPayroll(db, "p1")).toEqual({ ok: true, data: true });
    expect(await readsPayroll(db, "p1")).toEqual({ ok: true, data: false });
    expect(await activeAirportCodes(db, ["MIA", "XXX", "mia", "MIA"])).toEqual({
      ok: true,
      data: new Set(["MIA"]),
    });
    expect(calls[2]?.steps).toContainEqual(["in", ["iata_code", ["MIA", "XXX"]]]);
    expect(await activeAirportCodes(db, ["Terminal"])).toEqual({ ok: true, data: new Set() });
  });
});

describe("draft sources and saved drafts (B15)", () => {
  it("lists verified, live project inbox mail without its body", async () => {
    const { db, calls } = fakeClient({
      "from:inbound_addresses": [okResponse([{ id: "a1" }]), okResponse([])],
      "from:inbound_messages": [
        okResponse([
          {
            id: "m1",
            subject_line: "Advance",
            from_address: "tm@band.test",
            received_at: "2026-10-30T00:00:00Z",
          },
        ]),
      ],
    });
    expect(await listDraftSources(db, "p1")).toEqual({
      ok: true,
      data: [
        {
          id: "m1",
          subject: "Advance",
          fromAddress: "tm@band.test",
          receivedAt: "2026-10-30T00:00:00Z",
        },
      ],
    });
    const steps = calls.find((c) => c.target === "from:inbound_messages")?.steps ?? [];
    expect(steps).toContainEqual(["eq", ["dkim_verified", true]]);
    expect(steps).toContainEqual(["is", ["discarded_at", null]]);
    expect(JSON.stringify(steps)).not.toContain("body_text");
    expect(await listDraftSources(db, "p2")).toEqual({ ok: true, data: [] });
  });

  it("refuses to save a draft the database will not file", async () => {
    const { db } = fakeClient({
      "from:documents": [
        errorResponse("42501", "new row violates row-level security policy for table documents"),
      ],
    });
    expect(
      await saveDraftDocument(db, {
        orgId: "o1",
        projectId: "p1",
        title: "Waste Plan",
        markdown: "# x",
      }),
    ).toMatchObject({
      ok: false,
    });
  });
});
