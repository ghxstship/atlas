import { describe, expect, it } from "vitest";
import {
  acceptRepresentation,
  addAccountMember,
  addAvailabilityBlock,
  averageScore,
  awaitingSignature,
  base32ToUuid,
  createAvailabilityCalendar,
  createExternalAccount,
  endAccountMembership,
  fromDisplayKey,
  getEngagement,
  getThread,
  isCurrentEngagement,
  listAccountMembers,
  listAvailability,
  listEngagementDocuments,
  listMessages,
  listMyAccounts,
  listMyEngagements,
  listOnboardingItems,
  listPayments,
  listPayoutAccounts,
  listRatingsAbout,
  listRepresentations,
  listSharedRecords,
  listTaxForms,
  listThreads,
  onboardingStanding,
  openThread,
  proposeRepresentation,
  rateEngagement,
  recordDate,
  removeAvailabilityBlock,
  replyToRating,
  representationStanding,
  req,
  revokeProfileShare,
  revokeRepresentation,
  sendMessage,
  shareProfile,
  signEngagementDocument,
  strongestAccountRole,
  submitOnboardingItem,
  submitTaxForm,
  toDisplayKey,
  totalsByCurrency,
  uuidToBase32,
  type OnboardingItem,
  type Representation,
} from "../src/gateway";
import { errorResponse, okResponse } from "./fake-client";
import { gatewayClient } from "./gateway-client";

const ID = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";

const engagementRow = {
  id: ID,
  org_id: "o1",
  org_name: "Northwind Live",
  project_id: "p1",
  project_name: "Harbor Lights",
  role_type: "Crew",
  role_code: "5000.01.01-A2",
  job_title: "A2",
  person_id: "me",
  account_id: null,
  pay_basis: "Day",
  arrangement: "Freelance",
  rate_minor: null,
  rate_currency_code: null,
  start_date: "2026-11-01",
  end_date: "2026-11-03",
  engagement_state: "Active",
  areas: ["engagement", "operational"],
};

describe("display keys", () => {
  it("round-trips a uuid through Crockford base 32", () => {
    const encoded = uuidToBase32(ID);
    expect(encoded).toHaveLength(26);
    expect(base32ToUuid(encoded)).toBe(ID);
    const key = toDisplayKey("engagement", ID);
    expect(key).toMatch(/^[A-Z][A-Z0-9]{1,4}(?:-[A-Z0-9]+)+$/);
    expect(fromDisplayKey("engagement", key)).toBe(ID);
  });

  it("refuses malformed keys and the wrong kind", () => {
    expect(fromDisplayKey("thread", toDisplayKey("engagement", ID))).toBeNull();
    expect(fromDisplayKey("engagement", "ENG-NOTAKEY")).toBeNull();
    expect(base32ToUuid("Z".repeat(26))).toBeNull();
    expect(() => uuidToBase32("not-a-uuid")).toThrow();
  });
});

describe("engagements", () => {
  it("lists engagements with display keys and areas", async () => {
    const { db, calls } = gatewayClient({
      "from:api_external.engagements": [okResponse([engagementRow])],
    });
    const result = await listMyEngagements(db);
    expect(result.ok && result.data[0]?.key).toBe(toDisplayKey("engagement", ID));
    expect(result.ok && result.data[0]?.rateMinor).toBeNull();
    expect(result.ok && result.data[0]?.areas).toEqual(["engagement", "operational"]);
    expect(calls[0]?.steps[1]).toEqual(["order", ["start_date", { ascending: true }]]);
  });

  it("reads one engagement or says not found", async () => {
    const { db } = gatewayClient({
      "from:api_external.engagements": [okResponse(engagementRow), okResponse(null)],
    });
    expect((await getEngagement(db, ID)).ok).toBe(true);
    expect(await getEngagement(db, ID)).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("maps read errors", async () => {
    const { db } = gatewayClient({
      "from:api_external.engagements": [
        errorResponse("PGRST301", "boom"),
        errorResponse("42501", "no"),
      ],
    });
    expect((await listMyEngagements(db)).ok).toBe(false);
    expect(await getEngagement(db, ID)).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("knows current engagement states", () => {
    expect(isCurrentEngagement({ state: "Blocked" })).toBe(true);
    expect(isCurrentEngagement({ state: "Complete" })).toBe(false);
  });

  it("refuses a missing NOT NULL column loudly", () => {
    expect(() => req(null, "engagements.id")).toThrow(/engagements.id/);
    expect(req(0, "x")).toBe(0);
  });
});

describe("documents", () => {
  const doc = {
    id: "d1",
    engagement_id: ID,
    document_kind: "Agreement",
    title: "Crew Agreement",
    document_id: null,
    expires_on: null,
    engagement_document_state: "Sent",
  };

  it("lists documents and finds those awaiting signature", async () => {
    const { db, calls } = gatewayClient({
      "from:api_external.engagement_documents": [okResponse([doc]), okResponse([])],
    });
    const one = await listEngagementDocuments(db, ID);
    expect(one.ok && awaitingSignature(one.data).map((d) => d.id)).toEqual(["d1"]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["engagement_id", ID]]);
    expect((await listEngagementDocuments(db)).ok).toBe(true);
  });

  it("signs through the RPC and reports refusals", async () => {
    const { db, calls } = gatewayClient({
      "rpc:sign_engagement_document": [
        okResponse("t1"),
        errorResponse("XR001", "lifecycle_transition: Not allowed.", "lifecycle_transition"),
      ],
    });
    expect(await signEngagementDocument(db, "d1")).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_document_id: "d1" }]]);
    const refused = await signEngagementDocument(db, "d1");
    expect(!refused.ok && refused.error.kind).toBe("refusal");
  });

  it("returns document read errors", async () => {
    const { db } = gatewayClient({
      "from:api_external.engagement_documents": [errorResponse("08000", "down")],
    });
    expect((await listEngagementDocuments(db)).ok).toBe(false);
  });
});

describe("onboarding", () => {
  const item = (over: Partial<Record<string, unknown>>) => ({
    id: "i1",
    engagement_id: ID,
    name: "W-9",
    item_kind: "Tax Form",
    is_blocking: false,
    verification_method: "Reviewer",
    submitted_at: null,
    latest_outcome: null,
    expires_on: null,
    passes: false,
    satisfied: false,
    ...over,
  });

  it("lists blocking items first", async () => {
    const { db } = gatewayClient({
      "from:api_external.onboarding_items": [
        okResponse([item({ id: "a" }), item({ id: "b", is_blocking: true })]),
        errorResponse("08000", "down"),
      ],
    });
    const result = await listOnboardingItems(db, ID);
    expect(result.ok && result.data.map((i) => i.id)).toEqual(["b", "a"]);
    expect((await listOnboardingItems(db)).ok).toBe(false);
  });

  it("derives the standing of an item", () => {
    const base: OnboardingItem = {
      id: "i",
      engagementId: ID,
      name: "n",
      kind: "Document Upload" as OnboardingItem["kind"],
      blocking: true,
      verification: "Reviewer",
      submittedAt: null,
      latestOutcome: null,
      expiresOn: null,
      passes: false,
      satisfied: false,
    };
    expect(onboardingStanding(base, "2026-10-14")).toBe("todo");
    expect(onboardingStanding({ ...base, submittedAt: "x" }, "2026-10-14")).toBe("review");
    expect(
      onboardingStanding({ ...base, submittedAt: "x", latestOutcome: "Failed" }, "2026-10-14"),
    ).toBe("todo");
    expect(onboardingStanding({ ...base, satisfied: true }, "2026-10-14")).toBe("verified");
    expect(
      onboardingStanding(
        { ...base, satisfied: true, latestOutcome: "Passed", expiresOn: "2026-01-01" },
        "2026-10-14",
      ),
    ).toBe("expired");
  });

  it("submits items and tax forms through the RPCs", async () => {
    const { db, calls } = gatewayClient({
      "rpc:submit_onboarding_item": [okResponse(null), okResponse(null)],
      "rpc:submit_tax_form": [
        okResponse("tf1"),
        errorResponse("XR001", "tin_format: nine digits.", "tin_format"),
      ],
    });
    expect((await submitOnboardingItem(db, "i1")).ok).toBe(true);
    expect((await submitOnboardingItem(db, "i1", "doc1")).ok).toBe(true);
    expect(calls[1]?.steps[0]).toEqual(["args", [{ p_item_id: "i1", p_document_id: "doc1" }]]);
    expect(await submitTaxForm(db, { orgId: "o1", formKind: "W-9", tin: "123456789" })).toEqual({
      ok: true,
      data: { taxFormId: "tf1" },
    });
    const refused = await submitTaxForm(db, {
      orgId: "o1",
      formKind: "W-9",
      tin: "12",
      accountId: "a1",
      foreignPerformerWithholding: false,
    });
    expect(!refused.ok && refused.error).toEqual({
      kind: "refusal",
      rule: "tin_format",
      message: "nine digits.",
    });
  });
});

describe("threads", () => {
  const thread = { id: ID, engagement_id: "e1", subject: "Load-in", created_at: "2026-10-01" };

  it("lists and reads threads", async () => {
    const { db } = gatewayClient({
      "from:api_external.engagement_threads": [
        okResponse([thread]),
        okResponse([]),
        okResponse(thread),
        okResponse(null),
        errorResponse("08000", "down"),
        errorResponse("08000", "down"),
      ],
    });
    const listed = await listThreads(db, "e1");
    expect(listed.ok && listed.data[0]?.key).toBe(toDisplayKey("thread", ID));
    expect((await listThreads(db)).ok).toBe(true);
    expect((await getThread(db, ID)).ok).toBe(true);
    expect((await getThread(db, ID)).ok).toBe(false);
    expect((await listThreads(db)).ok).toBe(false);
    expect((await getThread(db, ID)).ok).toBe(false);
  });

  it("lists messages, skipping the read when there are no threads", async () => {
    const { db } = gatewayClient({
      "from:api_external.engagement_messages": [
        okResponse([
          {
            id: "m1",
            engagement_thread_id: ID,
            author_person_id: "me",
            author_name: "Sam",
            body: "On my way",
            sent_at: "2026-10-01T10:00:00Z",
          },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    expect(await listMessages(db, [])).toEqual({ ok: true, data: [] });
    const result = await listMessages(db, [ID]);
    expect(result.ok && result.data[0]?.body).toBe("On my way");
    expect((await listMessages(db, [ID])).ok).toBe(false);
  });

  it("opens threads and sends messages", async () => {
    const { db, calls } = gatewayClient({
      "from:engagement_threads": [okResponse({ id: "t9" }), errorResponse("42501", "no")],
      "from:engagement_messages": [okResponse(null), errorResponse("23514", "empty")],
    });
    expect(await openThread(db, { engagementId: "e1", subject: " Parking " })).toEqual({
      ok: true,
      data: { threadId: "t9" },
    });
    expect(calls[0]?.steps[0]).toEqual(["insert", [{ engagement_id: "e1", subject: "Parking" }]]);
    expect((await openThread(db, { engagementId: "e1", subject: "x" })).ok).toBe(false);
    expect((await sendMessage(db, { threadId: "t9", body: " Hi " })).ok).toBe(true);
    const invalid = await sendMessage(db, { threadId: "t9", body: "" });
    expect(!invalid.ok && invalid.error.kind).toBe("invalid");
  });
});

describe("shared records", () => {
  const row = (id: string, starts: string | null, due: string | null) => ({
    id,
    project_id: "p1",
    record_kind: "Shift",
    record_subtype: null,
    record_state: "Scheduled",
    title: "Load In",
    starts_at: starts,
    ends_at: null,
    due_at: due,
    time_zone: "America/New_York",
  });

  it("orders records by their first date and filters by project and kind", async () => {
    const { db, calls } = gatewayClient({
      "from:api_external.records": [
        okResponse([row("b", "2026-11-02", null), row("a", null, "2026-11-01")]),
        errorResponse("08000", "down"),
      ],
    });
    const result = await listSharedRecords(db, { projectIds: ["p1"], kinds: ["Shift"] });
    expect(result.ok && result.data.map((r) => r.id)).toEqual(["a", "b"]);
    expect(calls[0]?.steps).toContainEqual(["in", ["record_kind", ["Shift"]]]);
    expect(await listSharedRecords(db, { projectIds: [] })).toEqual({ ok: true, data: [] });
    expect((await listSharedRecords(db)).ok).toBe(false);
    expect(recordDate({ startsAt: null, dueAt: null, endsAt: null })).toBe("9999-12-31");
  });
});

describe("money", () => {
  it("lists payments, tax forms and payout accounts", async () => {
    const { db } = gatewayClient({
      "from:api_external.payments": [
        okResponse([
          {
            id: ID,
            org_id: "o1",
            org_name: "Northwind Live",
            account_id: "a1",
            amount_minor: 125000,
            currency_code: "USD",
            paid_on: "2026-10-10",
            reference_identifier: "ACH-1",
            payment_state: "Complete",
          },
        ]),
        errorResponse("08000", "down"),
      ],
      "from:api_external.tax_forms": [
        okResponse([
          {
            id: "t1",
            org_id: "o1",
            org_name: "Northwind Live",
            person_id: "me",
            account_id: null,
            form_kind: "W-9",
            tin_last4: "6789",
            foreign_performer_withholding: null,
            signed_at: "2026-10-01",
          },
        ]),
        errorResponse("08000", "down"),
      ],
      "from:api_external.payout_accounts": [
        okResponse([
          {
            id: "pa1",
            org_id: "o1",
            person_id: "me",
            account_id: null,
            provider: "Stripe Connect",
            account_last4: "4242",
          },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    const payments = await listPayments(db);
    expect(payments.ok && payments.data[0]?.key).toBe(toDisplayKey("payment", ID));
    expect((await listPayments(db)).ok).toBe(false);
    const forms = await listTaxForms(db);
    expect(forms.ok && forms.data[0]?.foreignPerformerWithholding).toBe(false);
    expect((await listTaxForms(db)).ok).toBe(false);
    const payouts = await listPayoutAccounts(db);
    expect(payouts.ok && payouts.data[0]?.last4).toBe("4242");
    expect((await listPayoutAccounts(db)).ok).toBe(false);
  });

  it("totals per currency without mixing currencies", () => {
    expect(
      totalsByCurrency([
        { amountMinor: 100, currency: "USD" },
        { amountMinor: 50, currency: "EUR" },
        { amountMinor: 25, currency: "USD" },
      ]),
    ).toEqual([
      { currency: "EUR", amountMinor: 50 },
      { currency: "USD", amountMinor: 125 },
    ]);
  });
});

describe("accounts", () => {
  it("lists accounts with ordered roles and picks the strongest", async () => {
    const { db } = gatewayClient({
      "from:api_external.my_accounts": [
        okResponse([
          {
            account_id: "a1",
            name: "Bright Staffing",
            slug: "bright",
            organization_type: "For-Profit",
            my_roles: ["Account Member", "Account Admin"],
          },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    const result = await listMyAccounts(db);
    expect(result.ok && result.data[0]?.roles).toEqual(["Account Admin", "Account Member"]);
    expect((await listMyAccounts(db)).ok).toBe(false);
    expect(strongestAccountRole(["Account Member", "Account Finance"])).toBe("Account Finance");
    expect(strongestAccountRole([])).toBeNull();
  });

  it("lists members by name", async () => {
    const member = (name: string | null) => ({
      account_membership_id: `m-${name}`,
      account_id: "a1",
      person_id: `p-${name}`,
      full_name: name,
      valid_from: "2026-01-01",
      valid_to: null,
      roles: ["Account Member"],
    });
    const { db } = gatewayClient({
      "from:api_external.account_members": [
        okResponse([member("Zoe"), member(null), member("Ana")]),
        errorResponse("08000", "down"),
      ],
    });
    const result = await listAccountMembers(db, "a1");
    expect(result.ok && result.data.map((m) => m.fullName)).toEqual([null, "Ana", "Zoe"]);
    expect((await listAccountMembers(db, "a1")).ok).toBe(false);
  });

  it("creates accounts and manages members through the RPCs", async () => {
    const { db } = gatewayClient({
      "rpc:create_external_account": [
        okResponse("a1"),
        errorResponse("XR001", "slug_taken: Taken."),
      ],
      "rpc:add_account_member": [okResponse("m1"), errorResponse("42501", "no")],
      "rpc:end_account_membership": [okResponse(null), errorResponse("42501", "no")],
    });
    expect(await createExternalAccount(db, { name: "Bright", slug: "bright" })).toEqual({
      ok: true,
      data: { accountId: "a1" },
    });
    expect((await createExternalAccount(db, { name: "Bright", slug: "bright" })).ok).toBe(false);
    expect(
      await addAccountMember(db, { accountId: "a1", personId: "p2", role: "Account Member" }),
    ).toEqual({ ok: true, data: { membershipId: "m1" } });
    expect(
      (await addAccountMember(db, { accountId: "a1", personId: "p2", role: "Account Member" })).ok,
    ).toBe(false);
    expect((await endAccountMembership(db, "m1")).ok).toBe(true);
    expect((await endAccountMembership(db, "m1")).ok).toBe(false);
  });
});

describe("representation", () => {
  const rep: Representation = {
    id: "r1",
    accountId: "a1",
    accountName: "Signal Artists",
    artistPersonId: "me",
    artistName: "Juno",
    representativePersonId: null,
    expiresOn: "2027-01-01",
    acceptedAt: null,
    revokedAt: null,
    scopes: ["Offers"],
  };

  it("derives standing", () => {
    expect(representationStanding(rep, "2026-10-14")).toBe("pending");
    expect(representationStanding({ ...rep, acceptedAt: "x" }, "2026-10-14")).toBe("active");
    expect(representationStanding(rep, "2027-02-01")).toBe("expired");
    expect(representationStanding({ ...rep, revokedAt: "x" }, "2026-10-14")).toBe("revoked");
  });

  it("lists, proposes, accepts and revokes", async () => {
    const { db } = gatewayClient({
      "from:api_external.representations": [
        okResponse([
          {
            id: "r1",
            account_id: "a1",
            account_name: "Signal Artists",
            artist_person_id: "me",
            artist_name: "Juno",
            representative_person_id: null,
            expires_on: "2027-01-01",
            accepted_at: null,
            revoked_at: null,
            scopes: ["Offers", "Advance"],
          },
        ]),
        errorResponse("08000", "down"),
      ],
      "rpc:propose_representation": [
        okResponse("r2"),
        errorResponse("XR001", "representation_expiry: Future."),
      ],
      "rpc:accept_representation": [
        okResponse(null),
        errorResponse("XR001", "representation_not_acceptable: No."),
      ],
      "rpc:revoke_representation": [okResponse(null), errorResponse("42501", "no")],
    });
    const listed = await listRepresentations(db);
    expect(listed.ok && listed.data[0]?.scopes).toEqual(["Offers", "Advance"]);
    expect((await listRepresentations(db)).ok).toBe(false);
    const input = {
      accountId: "a1",
      artistPersonId: "p9",
      representativePersonId: null,
      expiresOn: "2027-01-01",
      scopes: ["Offers"] as const,
    };
    expect(await proposeRepresentation(db, input)).toEqual({
      ok: true,
      data: { representationId: "r2" },
    });
    expect((await proposeRepresentation(db, input)).ok).toBe(false);
    expect((await acceptRepresentation(db, "r1")).ok).toBe(true);
    expect((await acceptRepresentation(db, "r1")).ok).toBe(false);
    expect((await revokeRepresentation(db, "r1")).ok).toBe(true);
    expect((await revokeRepresentation(db, "r1")).ok).toBe(false);
  });
});

describe("profile shares", () => {
  it("shares chosen fields and revokes", async () => {
    const { db, calls } = gatewayClient({
      "rpc:share_profile": [
        okResponse("s1"),
        okResponse("s2"),
        errorResponse("XR001", "profile_share_fields: Once."),
      ],
      "rpc:revoke_profile_share": [okResponse(null), errorResponse("42501", "no")],
    });
    expect(
      await shareProfile(db, { orgId: "o1", fields: [{ key: "full_name", value: "Sam" }] }),
    ).toEqual({ ok: true, data: { profileShareId: "s1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_field_keys: ["full_name"], p_field_values: ["Sam"] }],
    ]);
    expect(
      (await shareProfile(db, { orgId: "o1", fields: [], accountId: "a1", engagementId: "e1" })).ok,
    ).toBe(true);
    expect((await shareProfile(db, { orgId: "o1", fields: [] })).ok).toBe(false);
    expect((await revokeProfileShare(db, "s1")).ok).toBe(true);
    expect((await revokeProfileShare(db, "s1")).ok).toBe(false);
  });
});

describe("availability", () => {
  it("lists, creates calendars, adds and removes blocks", async () => {
    const { db } = gatewayClient({
      "from:api_external.availability": [
        okResponse([
          {
            id: "b1",
            person_id: "me",
            availability_calendar_id: "c1",
            starts_at: "2026-11-01T00:00:00Z",
            ends_at: "2026-11-02T00:00:00Z",
            availability_kind: "Available",
          },
        ]),
        errorResponse("08000", "down"),
      ],
      "from:availability_calendars": [
        okResponse({ id: "c1" }),
        errorResponse("XR001", "time_zone: Unknown."),
      ],
      "from:availability_blocks": [
        okResponse(null),
        errorResponse("23514", "range"),
        okResponse(null),
        errorResponse("42501", "no"),
      ],
    });
    const listed = await listAvailability(db, "me");
    expect(listed.ok && listed.data[0]?.calendarId).toBe("c1");
    expect((await listAvailability(db, "me")).ok).toBe(false);
    const cal = { personId: "me", timeZone: "America/New_York", visibility: "Private" as const };
    expect(await createAvailabilityCalendar(db, cal)).toEqual({
      ok: true,
      data: { calendarId: "c1" },
    });
    expect((await createAvailabilityCalendar(db, cal)).ok).toBe(false);
    const block = { calendarId: "c1", startsAt: "a", endsAt: "b", kind: "Available" as const };
    expect((await addAvailabilityBlock(db, block)).ok).toBe(true);
    expect((await addAvailabilityBlock(db, block)).ok).toBe(false);
    expect((await removeAvailabilityBlock(db, "b1")).ok).toBe(true);
    expect((await removeAvailabilityBlock(db, "b1")).ok).toBe(false);
  });
});

describe("ratings", () => {
  const rating = {
    id: "r1",
    rater_side: "Organization",
    score: 5,
    comment: "Great work",
    submitted_at: "2026-10-01",
    rated_person_id: "me",
    rated_organization_id: null,
    rater_organization_id: "o1",
    reply: null,
    replied_at: null,
  };

  it("lists released ratings about a person or an organization", async () => {
    const { db, calls } = gatewayClient({
      "from:api_external.ratings": [
        okResponse([rating]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
    });
    expect((await listRatingsAbout(db, { personId: "me" })).ok).toBe(true);
    expect(calls[0]?.steps).toContainEqual(["eq", ["rated_person_id", "me"]]);
    expect((await listRatingsAbout(db, { organizationId: "a1" })).ok).toBe(true);
    expect(calls[1]?.steps).toContainEqual(["eq", ["rated_organization_id", "a1"]]);
    expect((await listRatingsAbout(db, { personId: "me" })).ok).toBe(false);
  });

  it("averages to one decimal and never invents a zero", () => {
    expect(averageScore([])).toBeNull();
    expect(averageScore([{ score: 5 }, { score: 4 }, { score: 4 }])).toBe(4.3);
  });

  it("rates and replies", async () => {
    const { db, calls } = gatewayClient({
      "from:ratings": [
        okResponse(null),
        errorResponse("XR001", "rating_engagement_not_complete: No."),
      ],
      "from:rating_replies": [okResponse(null), errorResponse("23505", "dup")],
    });
    expect(
      (await rateEngagement(db, { engagementId: "e1", score: 5, comment: " Thanks " })).ok,
    ).toBe(true);
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ engagement_id: "e1", rater_side: "Party", score: 5, comment: "Thanks" }],
    ]);
    expect((await rateEngagement(db, { engagementId: "e1", score: 3, comment: "" })).ok).toBe(
      false,
    );
    expect((await replyToRating(db, { ratingId: "r1", body: "Thank you" })).ok).toBe(true);
    const dup = await replyToRating(db, { ratingId: "r1", body: "Again" });
    expect(!dup.ok && dup.error.kind).toBe("conflict");
  });
});
