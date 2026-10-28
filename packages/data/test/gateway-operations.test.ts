import { describe, expect, it } from "vitest";
import {
  acceptEngagedShift,
  acceptOffer,
  acknowledgePurchaseOrder,
  advanceSectionOpen,
  agreeSelfBilling,
  brandForHost,
  brandForSlug,
  claimTokenSubmissions,
  counterOffer,
  decideClientApproval,
  declineOffer,
  getPublicOrganizationProfile,
  getPublicPersonProfile,
  hoursFromMinutes,
  invoiceTrackerStep,
  listOpportunitiesById,
  listPartyMessages,
  listPartyThreads,
  listReadReceipts,
  listSavedOpportunities,
  markThreadRead,
  onboardingObjectName,
  previewAdvance,
  previewTokenDocument,
  readView,
  revokeSelfBilling,
  saveOpportunity,
  sendPartyMessage,
  signTokenDocument,
  startPartyThread,
  submitAdvance,
  submitAdvanceAnswer,
  submitDeliverable,
  submitEngagedSubmittal,
  submitEngagementInvoice,
  submitTimesheet,
  toDisplayKey,
  unsaveOpportunity,
  uploadOnboardingFile,
} from "../src/gateway.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { gatewayClient } from "./gateway-client.ts";

const ID = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";

describe("readView", () => {
  it("reads a view with filters, and skips an empty membership filter", async () => {
    const { db, calls } = gatewayClient({
      "from:api_external.invoices": [okResponse([{ id: "i1" }]), errorResponse("08000", "down")],
    });
    const result = await readView(db, "invoices", {
      eq: { org_id: "o1" },
      in: ["project_id", ["p1"]],
      order: ["issued_on", "desc"],
      limit: 5,
    });
    expect(result).toEqual({ ok: true, data: [{ id: "i1" }] });
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "o1"]]);
    expect(calls[0]?.steps).toContainEqual([
      "order",
      ["issued_on", { ascending: false, nullsFirst: false }],
    ]);
    expect(await readView(db, "invoices", { in: ["project_id", []] })).toEqual({
      ok: true,
      data: [],
    });
    expect((await readView(db, "invoices")).ok).toBe(false);
  });
});

describe("party RPCs", () => {
  const cases: [string, (db: never) => Promise<{ ok: boolean }>][] = [
    ["rpc:accept_offer", (db) => acceptOffer(db, "o1")],
    ["rpc:decline_offer", (db) => declineOffer(db, { offerId: "o1", reason: "No" })],
    [
      "rpc:counter_offer",
      (db) =>
        counterOffer(db, {
          offerId: "o1",
          amountMinor: 50000,
          currency: "USD",
          rateType: "Day",
          startsOn: "2026-11-01",
          endsOn: "2026-11-02",
          message: "Two days",
        }),
    ],
    [
      "rpc:submit_engagement_invoice",
      (db) =>
        submitEngagementInvoice(db, {
          engagementId: "e1",
          invoiceNumber: "INV-1",
          issuedOn: "2026-10-15",
          dueOn: "2026-11-14",
          currency: "USD",
          lines: [{ description: "Day rate", quantity: 2, unitPriceMinor: 45000 }],
        }),
    ],
    ["rpc:agree_self_billing", (db) => agreeSelfBilling(db, "e1")],
    ["rpc:revoke_self_billing", (db) => revokeSelfBilling(db, "e1")],
    ["rpc:submit_timesheet", (db) => submitTimesheet(db, "t1")],
    ["rpc:accept_engaged_shift", (db) => acceptEngagedShift(db, "s1")],
    ["rpc:acknowledge_purchase_order", (db) => acknowledgePurchaseOrder(db, "po1")],
    [
      "rpc:submit_engaged_submittal",
      (db) =>
        submitEngagedSubmittal(db, { submittalId: "s1", expected: "Proposed", note: "Rev A" }),
    ],
    [
      "rpc:submit_engaged_advance_answer",
      (db) => submitAdvanceAnswer(db, { recipientId: "r1", sectionId: "s1", body: "Two risers" }),
    ],
    [
      "rpc:decide_client_approval",
      (db) => decideClientApproval(db, { requestId: "a1", decision: "Approved", response: "Go" }),
    ],
    [
      "rpc:submit_deliverable",
      (db) => submitDeliverable(db, { deliverableId: "d1", documentId: "doc1", message: "Done" }),
    ],
  ];
  it.each(cases)("%s succeeds and maps refusals", async (key, run) => {
    const { db } = gatewayClient({
      [key]: [
        okResponse("x1"),
        errorResponse("XR001", "lifecycle_transition: No.", "lifecycle_transition"),
      ],
    });
    expect((await run(db as never)).ok).toBe(true);
    expect((await run(db as never)).ok).toBe(false);
  });

  it("submits a submittal with the expected state and the note", async () => {
    const { db, calls } = gatewayClient({ "rpc:submit_engaged_submittal": [okResponse("t1")] });
    expect(
      await submitEngagedSubmittal(db, {
        submittalId: "s1",
        expected: "Returned",
        note: "Bridle points added",
      }),
    ).toEqual({ ok: true, data: { id: "t1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_submittal_id: "s1", p_expected: "Returned", p_note: "Bridle points added" }],
    ]);
  });

  it("claims token submissions", async () => {
    const { db } = gatewayClient({
      "rpc:claim_token_submissions": [
        okResponse([{ claimed_advance: 2, claimed_documents: 1 }]),
        okResponse([]),
        errorResponse("42501", "no"),
      ],
    });
    expect(await claimTokenSubmissions(db)).toEqual({
      ok: true,
      data: { advance: 2, documents: 1 },
    });
    expect(await claimTokenSubmissions(db)).toEqual({
      ok: true,
      data: { advance: 0, documents: 0 },
    });
    expect((await claimTokenSubmissions(db)).ok).toBe(false);
  });
});

describe("money helpers", () => {
  it("places an invoice on the payment tracker", () => {
    const base = {
      invoice_state: "Issued",
      approved_at: null,
      balance_minor: 100,
      applied_minor: 0,
      last_paid_on: null,
    };
    expect(invoiceTrackerStep(base)).toBe(0);
    expect(invoiceTrackerStep({ ...base, invoice_state: "Approved" })).toBe(1);
    expect(invoiceTrackerStep({ ...base, applied_minor: 40 })).toBe(2);
    expect(invoiceTrackerStep({ ...base, invoice_state: "Approved", scheduled_minor: 100 })).toBe(
      2,
    );
    expect(invoiceTrackerStep({ ...base, applied_minor: 100, balance_minor: 0 })).toBe(3);
  });

  it("turns minutes into hours and keeps null", () => {
    expect(hoursFromMinutes(90)).toBe(1.5);
    expect(hoursFromMinutes(null)).toBeNull();
  });
});

describe("onboarding uploads", () => {
  it("names objects under the org, engagement and item", () => {
    expect(
      onboardingObjectName({
        orgId: "o",
        engagementId: "e",
        itemId: "i",
        fileName: "My W-9 (1).pdf",
      }),
    ).toMatch(/^o\/e\/i\/[a-z0-9]+-My-W-9-1-.pdf$/);
    expect(
      onboardingObjectName({ orgId: "o", engagementId: "e", itemId: "i", fileName: "***" }),
    ).toMatch(/-upload$/);
  });

  it("uploads, registers and reports storage or database failures", async () => {
    const fake = gatewayClient({
      "rpc:register_onboarding_upload": [
        okResponse("doc1"),
        errorResponse("XR001", "onboarding_upload_checksum: Hex."),
      ],
    });
    const uploads: { error: { message: string } | null }[] = [
      { error: null },
      { error: null },
      { error: { message: "too big" } },
    ];
    (fake.db as unknown as Record<string, unknown>)["storage"] = {
      from: () => ({ upload: async () => uploads.shift() }),
    };
    const input = {
      objectName: "o/e/i/f.pdf",
      title: "W-9",
      body: new Blob(["x"]),
      contentType: "application/pdf",
      checksumSha256: "a".repeat(64),
    };
    expect(await uploadOnboardingFile(fake.db, input)).toEqual({
      ok: true,
      data: { documentId: "doc1" },
    });
    expect((await uploadOnboardingFile(fake.db, input)).ok).toBe(false);
    expect(await uploadOnboardingFile(fake.db, input)).toEqual({
      ok: false,
      error: { kind: "unexpected", message: "too big" },
    });
  });
});

describe("saved opportunities", () => {
  it("lists, saves and unsaves", async () => {
    const { db } = gatewayClient({
      "from:api_external.my_saved_opportunities": [
        okResponse([{ id: "s1", opportunity_id: ID, saved_at: "2026-10-01", is_open: null }]),
        errorResponse("08000", "down"),
      ],
      "from:saved_opportunities": [
        okResponse(null),
        errorResponse("23505", "dup"),
        okResponse(null),
        errorResponse("42501", "no"),
      ],
      "from:api_external.opportunities": [okResponse([]), errorResponse("08000", "down")],
    });
    const listed = await listSavedOpportunities(db);
    expect(listed.ok && listed.data[0]?.open).toBe(false);
    expect((await listSavedOpportunities(db)).ok).toBe(false);
    expect((await saveOpportunity(db, { personId: "me", opportunityId: ID })).ok).toBe(true);
    expect((await saveOpportunity(db, { personId: "me", opportunityId: ID })).ok).toBe(false);
    expect((await unsaveOpportunity(db, "s1")).ok).toBe(true);
    expect((await unsaveOpportunity(db, "s1")).ok).toBe(false);
    expect(await listOpportunitiesById(db, [])).toEqual({ ok: true, data: [] });
    expect((await listOpportunitiesById(db, [ID])).ok).toBe(true);
    expect((await listOpportunitiesById(db, [ID])).ok).toBe(false);
  });
});

describe("party conversations", () => {
  it("lists threads with keys and unread counts, and their messages", async () => {
    const { db } = gatewayClient({
      "from:api_external.party_threads": [
        okResponse([
          {
            id: ID,
            org_id: "o1",
            org_name: "Northwind Live",
            subject: "Availability",
            created_at: "x",
            last_message_at: null,
            unread_count: null,
          },
        ]),
        errorResponse("08000", "down"),
      ],
      "from:api_external.party_messages": [
        okResponse([
          {
            id: "m1",
            party_thread_id: ID,
            author_person_id: "me",
            author_name: "Sam",
            body: "Hi",
            sent_at: "x",
          },
        ]),
        errorResponse("08000", "down"),
      ],
      "from:api_external.thread_read_receipts": [
        okResponse([{ person_id: "p2", person_name: "Ada", last_read_at: "x" }]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
    });
    const threads = await listPartyThreads(db);
    expect(threads.ok && threads.data[0]).toMatchObject({
      key: toDisplayKey("thread", ID),
      unread: 0,
    });
    expect((await listPartyThreads(db)).ok).toBe(false);
    expect((await listPartyMessages(db, ID)).ok).toBe(true);
    expect((await listPartyMessages(db, ID)).ok).toBe(false);
    expect((await listReadReceipts(db, { partyThreadId: ID })).ok).toBe(true);
    expect((await listReadReceipts(db, { engagementThreadId: ID })).ok).toBe(true);
    expect((await listReadReceipts(db, { partyThreadId: ID })).ok).toBe(false);
  });

  it("starts threads, sends messages and marks read", async () => {
    const { db } = gatewayClient({
      "rpc:start_party_thread": [okResponse("t1"), errorResponse("42501", "no")],
      "from:party_messages": [okResponse(null), errorResponse("23514", "empty")],
      "rpc:mark_thread_read": [okResponse("r"), okResponse("r"), errorResponse("42501", "no")],
    });
    const input = {
      orgId: "o1",
      subject: " Hello ",
      body: " First ",
      personId: "me",
      accountId: null,
    };
    expect(await startPartyThread(db, input)).toEqual({ ok: true, data: { threadId: "t1" } });
    expect((await startPartyThread(db, input)).ok).toBe(false);
    expect((await sendPartyMessage(db, { threadId: "t1", body: "Hi" })).ok).toBe(true);
    expect((await sendPartyMessage(db, { threadId: "t1", body: "" })).ok).toBe(false);
    expect((await markThreadRead(db, { partyThreadId: "t1" })).ok).toBe(true);
    expect((await markThreadRead(db, { engagementThreadId: "t1" })).ok).toBe(true);
    expect((await markThreadRead(db, { partyThreadId: "t1" })).ok).toBe(false);
  });
});

describe("api_public", () => {
  const brand = {
    org_slug: "northwind",
    name: "Northwind Live",
    logo_light_path: null,
    logo_dark_path: null,
    favicon_path: null,
    app_icon_path: null,
    accent_hex: "#3355AA",
    neutral_tint_hex: null,
    font_family: null,
    radius_scale: null,
    suppress_powered_by: false,
  };

  it("resolves brands by host and slug", async () => {
    const { db } = gatewayClient({
      "rpc:org_brand_for_host": [
        okResponse([
          { ...brand, surface: "Atlas" },
          { ...brand, surface: "Gateway" },
        ]),
        okResponse(null),
        errorResponse("08000", "down"),
      ],
      "rpc:org_brand_for_slug": [okResponse([brand]), okResponse([])],
    });
    const db2 = db as unknown as Record<string, unknown>;
    db2["schema"] = () => ({
      rpc: (fn: string, args: unknown) =>
        (db as unknown as { rpc(f: string, a: unknown): unknown }).rpc(fn, args),
    });
    expect((await brandForHost(db, "gateway.northwind.test")).ok).toBe(true);
    expect(await brandForHost(db, "x.test")).toEqual({ ok: true, data: null });
    expect((await brandForHost(db, "x.test")).ok).toBe(false);
    const bySlug = await brandForSlug(db, "northwind");
    expect(bySlug.ok && bySlug.data?.name).toBe("Northwind Live");
    expect(await brandForSlug(db, "none")).toEqual({ ok: true, data: null });
  });

  it("reads public profiles section by section", async () => {
    const empty = () => [okResponse([]), okResponse([])];
    const { db } = gatewayClient({
      "rpc:person_profile": [
        okResponse([{ handle: "sam", full_name: "Sam" }]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
      "rpc:person_profile_skills": [...empty(), okResponse([])],
      "rpc:person_profile_languages": [...empty(), okResponse([])],
      "rpc:person_profile_links": [...empty(), okResponse([])],
      "rpc:person_profile_portfolio": [...empty(), okResponse([])],
      "rpc:person_profile_references": [...empty(), okResponse([])],
      "rpc:person_profile_certifications": [...empty(), okResponse([])],
      "rpc:person_profile_organizations": [...empty(), okResponse([])],
      "rpc:organization_profile": [
        okResponse([{ handle: "nw", name: "Northwind" }]),
        okResponse([]),
        errorResponse("08000", "down"),
        okResponse([]),
      ],
      "rpc:organization_profile_details": [
        okResponse([]),
        okResponse([]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
    });
    (db as unknown as Record<string, unknown>)["schema"] = () => ({
      rpc: (fn: string, args: unknown) =>
        (db as unknown as { rpc(f: string, a: unknown): unknown }).rpc(fn, args),
    });
    const person = await getPublicPersonProfile(db, "sam");
    expect(person.ok && person.data?.profile.full_name).toBe("Sam");
    expect(await getPublicPersonProfile(db, "nobody")).toEqual({ ok: true, data: null });
    expect((await getPublicPersonProfile(db, "sam")).ok).toBe(false);
    const org = await getPublicOrganizationProfile(db, "nw");
    expect(org.ok && org.data?.profile.name).toBe("Northwind");
    expect(await getPublicOrganizationProfile(db, "none")).toEqual({ ok: true, data: null });
    expect((await getPublicOrganizationProfile(db, "nw")).ok).toBe(false);
    expect((await getPublicOrganizationProfile(db, "nw")).ok).toBe(false);
  });

  it("previews and signs token documents, returning refusals as values", async () => {
    const { db } = gatewayClient({
      "rpc:token_document": [
        okResponse([
          {
            refusal: null,
            reason: null,
            org_name: "Northwind Live",
            project_name: "Harbor",
            document_kind: "Agreement",
            title: "Crew Agreement",
            document_state: "Sent",
            expires_on: null,
            storage_uri: null,
            recipient_email: "a@example.com",
            link_expires_at: null,
            signed_at: null,
            signer_name: null,
          },
        ]),
        okResponse([{ refusal: "REFUSE", reason: "document_access_code" }]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
      "rpc:token_sign_document": [
        okResponse([{ signed_at: "2026-10-15T10:00:00Z", refusal: null, reason: null }]),
        okResponse([{ signed_at: null, refusal: "REFUSE", reason: "document_signer_name" }]),
        errorResponse("08000", "down"),
      ],
    });
    (db as unknown as Record<string, unknown>)["schema"] = () => ({
      rpc: (fn: string, args: unknown) =>
        (db as unknown as { rpc(f: string, a: unknown): unknown }).rpc(fn, args),
    });
    const input = { token: "t", accessCode: "123456" };
    const doc = await previewTokenDocument(db, input);
    expect(doc.ok && !doc.data.refused && doc.data.title).toBe("Crew Agreement");
    expect(await previewTokenDocument(db, input)).toEqual({
      ok: true,
      data: { refused: true, reason: "document_access_code" },
    });
    expect(await previewTokenDocument(db, input)).toEqual({
      ok: true,
      data: { refused: true, reason: "token_invalid" },
    });
    expect((await previewTokenDocument(db, input)).ok).toBe(false);
    expect(await signTokenDocument(db, { ...input, signerName: "Sam" })).toEqual({
      ok: true,
      data: { refused: false, signedAt: "2026-10-15T10:00:00Z" },
    });
    expect(await signTokenDocument(db, { ...input, signerName: "" })).toEqual({
      ok: true,
      data: { refused: true, reason: "document_signer_name" },
    });
    expect((await signTokenDocument(db, { ...input, signerName: "Sam" })).ok).toBe(false);
  });

  it("previews and answers advance packets", async () => {
    const section = (id: string, position: number) => ({
      refusal: null,
      reason: null,
      org_name: "Northwind Live",
      packet_title: "Artist Advance",
      due_at: null,
      recipient_email: "a@example.com",
      expires_at: null,
      section_id: id,
      section_position: position,
      section_title: `Section ${position}`,
      section_prompt: null,
      answer_body: null,
      answered_at: null,
      review_outcome: null,
      return_reason: null,
    });
    const { db } = gatewayClient({
      "rpc:preview_advance": [
        okResponse([section("s2", 2), section("s1", 1)]),
        okResponse([{ refusal: "REFUSE", reason: "advance_token_expired" }]),
        errorResponse("08000", "down"),
      ],
      "rpc:submit_advance": [
        okResponse([
          { submission_id: "x", submitted_at: "2026-10-15", refusal: null, reason: null },
        ]),
        okResponse([
          {
            submission_id: null,
            submitted_at: null,
            refusal: "REFUSE",
            reason: "advance_answer_length",
          },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    (db as unknown as Record<string, unknown>)["schema"] = () => ({
      rpc: (fn: string, args: unknown) =>
        (db as unknown as { rpc(f: string, a: unknown): unknown }).rpc(fn, args),
    });
    const input = { token: "t", accessCode: "1" };
    const packet = await previewAdvance(db, input);
    expect(packet.ok && !packet.data.refused && packet.data.sections.map((s) => s.id)).toEqual([
      "s1",
      "s2",
    ]);
    expect(packet.ok && !packet.data.refused && packet.data.sections[0]).toMatchObject({
      reviewOutcome: null,
      returnReason: null,
    });
    expect(await previewAdvance(db, input)).toEqual({
      ok: true,
      data: { refused: true, reason: "advance_token_expired" },
    });
    expect((await previewAdvance(db, input)).ok).toBe(false);
    const answer = { ...input, sectionId: "s1", body: "Two risers" };
    expect(await submitAdvance(db, answer)).toEqual({
      ok: true,
      data: { refused: false, submittedAt: "2026-10-15" },
    });
    expect(await submitAdvance(db, answer)).toEqual({
      ok: true,
      data: { refused: true, reason: "advance_answer_length" },
    });
    expect((await submitAdvance(db, answer)).ok).toBe(false);
  });
});

describe("advance sections", () => {
  it("maps the review of the latest answer", async () => {
    const { db } = gatewayClient({
      "rpc:preview_advance": [
        okResponse([
          {
            refusal: null,
            reason: null,
            org_name: "Northwind Live",
            packet_title: "Artist Advance",
            due_at: null,
            recipient_email: null,
            expires_at: null,
            section_id: "s1",
            section_position: 1,
            section_title: "Arrival",
            section_prompt: null,
            answer_body: "Lands at noon.",
            answered_at: "2027-05-01",
            review_outcome: "Returned",
            return_reason: "Which airport?",
          },
        ]),
      ],
    });
    (db as unknown as Record<string, unknown>)["schema"] = () => ({
      rpc: (fn: string, args: unknown) =>
        (db as unknown as { rpc(f: string, a: unknown): unknown }).rpc(fn, args),
    });
    const packet = await previewAdvance(db, { token: "t", accessCode: "1" });
    expect(packet.ok && !packet.data.refused && packet.data.sections[0]).toMatchObject({
      reviewOutcome: "Returned",
      returnReason: "Which airport?",
    });
  });

  it("opens a section that is unanswered or returned", () => {
    expect(advanceSectionOpen({ answer: null, reviewOutcome: null })).toBe(true);
    expect(advanceSectionOpen({ answer: "Noon.", reviewOutcome: "Returned" })).toBe(true);
    expect(advanceSectionOpen({ answer: "Noon.", reviewOutcome: null })).toBe(false);
    expect(advanceSectionOpen({ answer: "Noon.", reviewOutcome: "Accepted" })).toBe(false);
  });
});
