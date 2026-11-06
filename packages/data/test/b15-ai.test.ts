import { describe, expect, it } from "vitest";
import {
  advanceDraftScope,
  applyContractIntake,
  applyInvoiceLineSuggestions,
  applyItineraryLines,
  auroraIntakeScope,
  contractIntakeOptions,
  getInvoiceTieOut,
  itineraryTravelerCandidates,
  listAnswerSources,
  listInvoiceLineProposals,
  listOpenProposals,
  recordDraftedAdvanceAnswer,
  vendorLineHistory,
} from "../src/ai.ts";
import { raiseAttachmentToRestricted, uploadRestrictedAttachment } from "../src/attachments.ts";
import { listDraftSources } from "../src/project-inbox.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

describe("Aurora intake (B15)", () => {
  it("checks the scope, keeping a capability refusal", async () => {
    const { db, calls } = fakeClient({
      "rpc:aurora_intake_scope": [
        okResponse({ project_id: "p1", fee_visible: true, can_write_riders: false }),
        errorResponse(
          "42501",
          "this needs opportunities.engagement.write on the project in your org",
        ),
      ],
    });
    expect(await auroraIntakeScope(db, "contract", "p1")).toEqual({
      ok: true,
      data: { project_id: "p1", fee_visible: true, can_write_riders: false },
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([{ p_kind: "contract", p_project_id: "p1" }]);
    expect((await auroraIntakeScope(db, "contract", "p1")).ok).toBe(false);
  });

  it("reads traveler candidates and contract options", async () => {
    const { db } = fakeClient({
      "rpc:itinerary_traveler_candidates": [
        okResponse([
          { person_id: "a", engagement_id: null, display_name: "Dana Kim", source: "Member" },
        ]),
      ],
      "rpc:contract_intake_options": [okResponse({ parties: [], rate_cards: [] })],
    });
    expect(await itineraryTravelerCandidates(db, "p1")).toEqual({
      ok: true,
      data: [{ person_id: "a", engagement_id: null, display_name: "Dana Kim", source: "Member" }],
    });
    expect(await contractIntakeOptions(db, "p1")).toEqual({
      ok: true,
      data: { parties: [], rate_cards: [] },
    });
  });

  it("applies itinerary lines, a line's wrong value reading as invalid", async () => {
    const { db, calls } = fakeClient({
      "rpc:apply_itinerary_lines": [
        okResponse({ written: [{ suggestion_id: "s", id: "t" }], duplicates_checked: 1 }),
        errorResponse("22P02", "Line 1: invalid input syntax"),
        errorResponse(
          "XR001",
          "aurora_itinerary_duplicate: Line 1 is already booked for this traveler.",
          "aurora_itinerary_duplicate",
        ),
      ],
    });
    const input = {
      projectId: "p1",
      fulfillmentId: null,
      items: [{ suggestion_id: "s", values: { person_id: "a" } }],
    };
    expect(await applyItineraryLines(db, input)).toMatchObject({
      ok: true,
      data: { duplicates_checked: 1 },
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { p_project_id: "p1", p_fulfillment_id: null, p_items: input.items },
    ]);
    expect(await applyItineraryLines(db, input)).toEqual({
      ok: false,
      error: { kind: "invalid", message: "Line 1: invalid input syntax" },
    });
    expect(await applyItineraryLines(db, input)).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "aurora_itinerary_duplicate" },
    });
  });

  it("applies a contract review", async () => {
    const { db, calls } = fakeClient({
      "rpc:apply_contract_intake": [okResponse({ engagements: [], riders: 0 })],
    });
    const items = [{ suggestion_ids: ["s"], party: { counterparty_id: "c" } }];
    expect(await applyContractIntake(db, { projectId: "p1", items })).toEqual({
      ok: true,
      data: { engagements: [], riders: 0 },
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([{ p_project_id: "p1", p_items: items }]);
  });

  it("resumes the caller's open proposals with their fields, asking no model", async () => {
    const { db, calls } = fakeClient({
      "from:ai_requests": [okResponse([{ id: "r1" }])],
      "from:ai_suggestions": [
        okResponse([
          {
            id: "s1",
            request_id: "r1",
            operation_id: "travelSegments.create",
            target_id: null,
            summary: "x",
            expires_at: "2027-01-08T00:00:00Z",
          },
        ]),
      ],
      "from:ai_suggestion_fields": [
        okResponse([
          {
            suggestion_id: "s1",
            field_path: "departs_from",
            proposed_value: "MIA",
            confidence: 0.9,
            refusal: null,
            missing: null,
            source_excerpt: "MIA",
          },
        ]),
      ],
    });
    const result = await listOpenProposals(db, {
      personId: "me",
      projectId: "p1",
      operationId: "travelSegments.create",
    });
    expect(result).toMatchObject({
      ok: true,
      data: [{ id: "s1", proposed_fields: [{ field_path: "departs_from" }] }],
    });
    const requests = calls.find((c) => c.target === "from:ai_requests");
    expect(requests?.steps).toContainEqual(["eq", ["subject_table", "app.projects"]]);
    expect(requests?.steps).toContainEqual(["eq", ["person_id", "me"]]);
    const suggestions = calls.find((c) => c.target === "from:ai_suggestions");
    expect(suggestions?.steps).toContainEqual(["eq", ["suggestion_state", "Proposed"]]);
  });

  it("has no open proposals without a request", async () => {
    const { db } = fakeClient({ "from:ai_requests": [okResponse([])] });
    expect(
      await listOpenProposals(db, { personId: "me", projectId: "p1", operationId: "x.y" }),
    ).toEqual({ ok: true, data: [] });
  });

  it("finds an invoice's lines through the header saved as that invoice", async () => {
    const { db, calls } = fakeClient({
      "from:ai_suggestions": [
        okResponse([{ request_id: "r1" }]),
        okResponse([
          {
            id: "l1",
            request_id: "r1",
            operation_id: "invoiceLines.create",
            target_id: null,
            summary: "x",
            expires_at: "2027-01-08T00:00:00Z",
          },
        ]),
      ],
      "from:ai_suggestion_fields": [okResponse([])],
    });
    expect(await listInvoiceLineProposals(db, "i1", "me")).toMatchObject({
      ok: true,
      data: [{ id: "l1" }],
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["applied_id", "i1"]]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["operation_id", "invoices.create"]]);
    expect(calls[1]?.steps).toContainEqual(["in", ["request_id", ["r1"]]]);
  });

  it("applies invoice lines, reads history and the tie-out", async () => {
    const { db, calls } = fakeClient({
      "rpc:apply_invoice_line_suggestions": [okResponse({ written: [] })],
      "rpc:vendor_line_history": [okResponse([{ description_index: 1 }])],
      "from:invoice_tie_out": [
        okResponse({
          invoice_id: "i1",
          printed_total_minor: 100,
          computed_total_minor: 90,
          residual_minor: 10,
        }),
      ],
    });
    expect(
      await applyInvoiceLineSuggestions(db, "i1", [{ suggestion_id: "s", values: {} }]),
    ).toEqual({ ok: true, data: { written: [] } });
    expect(await vendorLineHistory(db, "i1", ["Rental"])).toEqual({
      ok: true,
      data: [{ description_index: 1 }],
    });
    expect(calls[1]?.steps[0]?.[1]).toEqual([{ p_invoice_id: "i1", p_descriptions: ["Rental"] }]);
    expect(await getInvoiceTieOut(db, "i1")).toMatchObject({
      ok: true,
      data: { residual_minor: 10 },
    });
  });

  it("reads the draft scope and records an answer", async () => {
    const { db, calls } = fakeClient({
      "rpc:advance_draft_scope": [okResponse({ recipient_id: "r", sections: [] })],
      "rpc:record_drafted_advance_answer": [okResponse("a1")],
    });
    expect(await advanceDraftScope(db, "r")).toMatchObject({
      ok: true,
      data: { recipient_id: "r" },
    });
    expect(await recordDraftedAdvanceAnswer(db, "s1", { text: "x" })).toEqual({
      ok: true,
      data: "a1",
    });
    expect(calls[1]?.steps[0]?.[1]).toEqual([{ p_suggestion_id: "s1", p_values: { text: "x" } }]);
  });

  it("reads an answer's source with its sender, and an accepter's name", async () => {
    const { db } = fakeClient({
      "from:advance_answer_sources": [
        okResponse([
          {
            advance_submission_id: "a1",
            source_kind: "Project Inbox",
            inbound_message_id: "m1",
            file_name: null,
            source_excerpt: "Load in",
            created_by: "p1",
          },
        ]),
      ],
      "from:inbound_messages": [okResponse([{ id: "m1", from_address: "a@example.com" }])],
      "rpc:person_names": [okResponse([{ person_id: "p1", full_name: "Dana Kim" }])],
    });
    expect(await listAnswerSources(db, ["a1"])).toEqual({
      ok: true,
      data: [
        {
          submissionId: "a1",
          sourceKind: "Project Inbox",
          fileName: null,
          excerpt: "Load in",
          fromAddress: "a@example.com",
          accepterName: "Dana Kim",
        },
      ],
    });
    expect(await listAnswerSources(db, [])).toEqual({ ok: true, data: [] });
  });

  it("lists verified mail with a body, for the source list", async () => {
    const { db, calls } = fakeClient({
      "from:inbound_addresses": [okResponse([{ id: "ad" }])],
      "from:inbound_messages": [
        okResponse([
          {
            id: "m1",
            subject_line: "Advance",
            from_address: "a@example.com",
            received_at: "2027-01-01T00:00:00Z",
            body_text: "Load in",
          },
          {
            id: "m2",
            subject_line: "Blank",
            from_address: "b@example.com",
            received_at: "2027-01-01T00:00:00Z",
            body_text: "  ",
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
          fromAddress: "a@example.com",
          receivedAt: "2027-01-01T00:00:00Z",
        },
      ],
    });
    const messages = calls.find((c) => c.target === "from:inbound_messages");
    expect(messages?.steps).toContainEqual(["in", ["inbound_status", ["Verified", "Filed"]]]);
    expect(messages?.steps).toContainEqual(["eq", ["purpose", "Project Inbox"]]);
  });
});

describe("a contract's file (B15)", () => {
  const upload = () => ({
    subject: { table: "app.engagement_documents", id: "d1" },
    file: new Blob(["x"], { type: "text/plain" }),
    filename: "contract.txt",
  });
  const storage = { from: () => ({ upload: async () => ({ error: null }) }) };

  it("raises a file to Restricted", async () => {
    const { db, calls } = fakeClient({ "from:attachments": [okResponse(null)] });
    expect(await raiseAttachmentToRestricted(db, "a1")).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps).toContainEqual(["update", [{ classification: "Restricted" }]]);
  });

  it("removes the attachment when the raise fails, and reports it", async () => {
    const { db, calls } = fakeClient({
      "rpc:begin_attachment_upload": [
        okResponse([{ attachment_id: "a1", version_id: "v1", object_name: "o" }]),
      ],
      "rpc:complete_attachment_upload": [okResponse("Pending")],
      "from:attachments": [errorResponse("42501", "denied"), okResponse([{ id: "a1" }])],
    });
    Object.assign(db, { storage });
    expect((await uploadRestrictedAttachment(db, upload())).ok).toBe(false);
    const updates = calls.filter((c) => c.target === "from:attachments");
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates[1]?.steps)).toContain("deleted_at");
  });
});
