import { describe, expect, it } from "vitest";
import * as repo from "../src/opportunities";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client";

/** A fake client that also answers `schema("xpms").from(...)` from `xpms:<table>` queues. */
function client(queues: Record<string, Response[]>) {
  const { db, calls } = fakeClient(queues);
  const withSchema = Object.assign(db, {
    schema: () => ({ from: (table: string) => db.from(`xpms:${table}` as "projects") }),
  });
  return { db: withSchema, calls };
}

const refusal = errorResponse(
  "XR001",
  "requisition_required: Publish from an Approved requisition.",
);
const hidden = errorResponse("42501", "permission denied");

const OPPORTUNITY = {
  id: "o1",
  project_id: "p1",
  title: "Summer Series Riggers",
  role_type: "Crew",
  role_code: "5000.51.02",
  visibility: "Invited",
  rate_type: "Day",
  pay_min_minor: 80000,
  pay_max_minor: 95000,
  currency_code: "USD",
  starts_on: "2027-06-01",
  ends_on: "2027-06-03",
  deadline_at: null,
  opportunity_state: "Draft",
  requisition_id: "r1",
  updated_at: "2026-10-01T00:00:00Z",
  description: "Two riggers.",
  scope_node_id: null,
  venue_id: "v1",
  jurisdiction_id: null,
  minimum_age: null,
  project: { project_key: "NWL", name: "Northwind Summer Series" },
  positions: [
    { id: "pos1", label: "Rigger 1", call_at: null, ends_at: null, deleted_at: null },
    {
      id: "pos2",
      label: "Rigger 2",
      call_at: null,
      ends_at: null,
      deleted_at: "2026-10-02T00:00:00Z",
    },
  ],
  applications: [{ id: "a1", deleted_at: null }],
};

const BOARD = {
  application_id: "a1",
  opportunity_id: "o1",
  opportunity_title: "Summer Series Riggers",
  project_id: "p1",
  project_key: "NWL",
  role_type: "Crew",
  applicant_kind: "Person",
  applicant_name: "Ivy Marchetti",
  applicant_person_id: "ivy",
  applicant_organization_id: null,
  application_state: "In Review",
  submitted_at: "2026-10-03T00:00:00Z",
  availability_confirmed: true,
  cover_note: null,
  proposed_fee_minor: null,
  currency_code: null,
  shortlist_rank: 1,
  next_interview_at: null,
  offer_id: null,
  offer_state: null,
  offer_turn_side: null,
  offer_rate_type: null,
  offer_amount_minor: null,
  offer_currency_code: null,
  offer_expires_at: null,
  has_bid: true,
  bid_sealed: true,
  bid_total_minor: null,
  engagement_id: null,
};

const ENGAGEMENT = {
  engagement_id: "e1",
  project_id: "p1",
  project_key: "NWL",
  project_name: "Northwind Summer Series",
  party_name: "Ivy Marchetti",
  person_id: "ivy",
  account_id: null,
  account_name: null,
  role_type: "Crew",
  role_code: "5000.51.02",
  job_title: "Head Arena / Festival Rigger",
  worker_classification: "INDEPENDENT_CONTRACTOR",
  engagement_state: "Onboarding",
  start_date: "2027-06-01",
  end_date: null,
  application_id: "a1",
  open_blocking_count: 2,
  onboarding_item_count: 3,
  documents_in_flight: 1,
  deliverables_to_review: 0,
  org_rated: false,
  party_rated: false,
  ratings_released: false,
};

describe("opportunities repository: lifecycles", () => {
  it("offers only moves the database declares", () => {
    expect(repo.OPPORTUNITY_MOVES.Draft).toEqual(["Pending Approval", "Canceled"]);
    expect(repo.OPPORTUNITY_MOVES.Closed).toEqual([]);
    expect(repo.APPLICATION_ORG_MOVES["In Review"]).toContain("Shortlisted");
    expect(repo.ENGAGEMENT_MOVES.Closing).toEqual(["Complete", "Active"]);
    expect(repo.DOCUMENT_ORG_MOVES.Signed).toContain("Executed");
    expect(repo.REQUISITION_ROLE_TYPES).toEqual(["Contractor", "Crew", "Staff"]);
    expect(repo.APPLICATION_STATES).toHaveLength(8);
  });
});

describe("opportunities repository: requisitions and postings", () => {
  it("lists requisitions with job titles and live opportunity counts", async () => {
    const { db } = client({
      "from:requisitions": [
        okResponse([
          {
            id: "r1",
            project_id: "p1",
            role_code: "5000.51.02",
            role_type: "Crew",
            headcount: 4,
            rate_minor: null,
            currency_code: "USD",
            starts_on: null,
            ends_on: null,
            justification: "Riggers.",
            requisition_state: "Approved",
            project: { project_key: "NWL" },
            opportunities: [
              { id: "o1", deleted_at: null },
              { id: "o2", deleted_at: "x" },
            ],
          },
        ]),
      ],
      "from:xpms:role": [
        okResponse([{ role_code: "5000.51.02", job_title: "Head Arena / Festival Rigger" }]),
      ],
    });
    const result = await repo.listRequisitions(db, "org");
    expect(result).toEqual({
      ok: true,
      data: [
        expect.objectContaining({
          jobTitle: "Head Arena / Festival Rigger",
          opportunityCount: 1,
          projectKey: "NWL",
        }),
      ],
    });
  });

  it("reports a failing requisition read and an empty title lookup", async () => {
    expect(
      (await repo.listRequisitions(client({ "from:requisitions": [hidden] }).db, "org")).ok,
    ).toBe(false);
    expect(await repo.jobTitles(client({}).db, [])).toEqual({ ok: true, data: new Map() });
    expect((await repo.jobTitles(client({ "from:xpms:role": [hidden] }).db, ["x"])).ok).toBe(false);
  });

  it("lists opportunities with live positions and applications", async () => {
    const { db, calls } = client({ "from:opportunities": [okResponse([OPPORTUNITY])] });
    const result = await repo.listOpportunities(db, "org", { projectId: "p1", states: ["Draft"] });
    expect(result).toEqual({
      ok: true,
      data: [expect.objectContaining({ positionCount: 1, applicationCount: 1, projectKey: "NWL" })],
    });
    expect(calls[0]?.steps.map(([s]) => s)).toEqual(["select", "eq", "is", "eq", "in", "order"]);
    expect(
      (await repo.listOpportunities(client({ "from:opportunities": [hidden] }).db, "org")).ok,
    ).toBe(false);
  });

  it("reads one opportunity with its children", async () => {
    const { db } = client({
      "from:opportunities": [okResponse(OPPORTUNITY)],
      "from:opportunity_requirements": [
        okResponse([
          {
            id: "q1",
            requirement_kind: "Equipment",
            description: "Own harness.",
            certification_id: null,
            insurance_minimum_minor: null,
            currency_code: null,
          },
        ]),
      ],
      "from:opportunity_questions": [
        okResponse([{ id: "qq", prompt: "Venues rigged?", sort_order: 1, is_required: true }]),
      ],
      "from:opportunity_invitations": [
        okResponse([{ id: "i1", person_id: "ivy", organization_id: null }]),
      ],
    });
    const result = await repo.getOpportunity(db, "o1");
    expect(result.ok && result.data.positions).toHaveLength(1);
    expect(result.ok && result.data.questions[0]?.required).toBe(true);
    expect(result.ok && result.data.invitations[0]?.personId).toBe("ivy");
  });

  it("answers not-found and child read failures", async () => {
    expect(
      await repo.getOpportunity(client({ "from:opportunities": [okResponse(null)] }).db, "o1"),
    ).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(
      (await repo.getOpportunity(client({ "from:opportunities": [hidden] }).db, "o1")).ok,
    ).toBe(false);
    const { db } = client({
      "from:opportunities": [okResponse(OPPORTUNITY)],
      "from:opportunity_requirements": [hidden],
      "from:opportunity_questions": [okResponse([])],
      "from:opportunity_invitations": [okResponse([])],
    });
    expect((await repo.getOpportunity(db, "o1")).ok).toBe(false);
  });

  it("creates, edits and moves opportunities", async () => {
    const { db, calls } = client({
      "from:opportunities": [
        okResponse({ id: "o9" }),
        okResponse(null),
        errorResponse("23514", "check"),
      ],
      "rpc:transition_opportunity": [okResponse("t1"), refusal],
    });
    expect(
      await repo.createOpportunity(db, {
        projectId: "p1",
        title: "Riggers",
        roleType: "Crew",
        visibility: "Invited",
        requisitionId: "r1",
        payMinMinor: 1,
      }),
    ).toEqual({ ok: true, data: { id: "o9" } });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toMatchObject({
      project_id: "p1",
      role_type: "Crew",
      requisition_id: "r1",
      pay_min_minor: 1,
    });
    expect(await repo.updateOpportunity(db, "o9", { title: "Lead Riggers" })).toEqual({
      ok: true,
      data: null,
    });
    expect(await repo.updateOpportunity(db, "o9", { title: "" })).toMatchObject({
      ok: false,
      error: { kind: "invalid" },
    });
    expect(
      await repo.transitionOpportunity(db, "o9", "Draft", "Pending Approval", "Ready."),
    ).toEqual({ ok: true, data: "t1" });
    expect(
      await repo.transitionOpportunity(db, "o9", "Pending Approval", "Published", "Go."),
    ).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "requisition_required" },
    });
    expect(
      (
        await repo.createOpportunity(client({ "from:opportunities": [hidden] }).db, {
          projectId: "p",
          title: "t",
          roleType: "Artist",
          visibility: "Invited",
        })
      ).ok,
    ).toBe(false);
  });

  it("adds and removes posting children", async () => {
    const { db, calls } = client({
      "from:opportunity_positions": [okResponse({ id: "pos" }), hidden],
      "from:opportunity_questions": [okResponse({ id: "q" }), hidden],
      "from:opportunity_requirements": [
        okResponse({ id: "rq" }),
        okResponse({ id: "rq2" }),
        hidden,
        okResponse(null),
      ],
      "from:opportunity_invitations": [
        okResponse({ id: "inv" }),
        okResponse({ id: "inv2" }),
        hidden,
      ],
    });
    expect(await repo.addPosition(db, "o1", { label: "Rigger 3" })).toEqual({
      ok: true,
      data: { id: "pos" },
    });
    expect((await repo.addPosition(db, "o1", { label: "x" })).ok).toBe(false);
    expect(
      await repo.addQuestion(db, "o1", { prompt: "Why?", sortOrder: 1, required: false }),
    ).toEqual({ ok: true, data: { id: "q" } });
    expect(
      (await repo.addQuestion(db, "o1", { prompt: "x", sortOrder: 2, required: true })).ok,
    ).toBe(false);
    expect(
      await repo.addRequirement(db, "o1", { kind: "Equipment", description: "Harness." }),
    ).toEqual({ ok: true, data: { id: "rq" } });
    expect(
      await repo.addRequirement(db, "o1", {
        kind: "Insurance",
        description: "GL.",
        minimumMinor: 100,
        currencyCode: "USD",
      }),
    ).toEqual({
      ok: true,
      data: { id: "rq2" },
    });
    expect(
      calls.find(
        (c) =>
          c.target === "from:opportunity_requirements" &&
          JSON.stringify(c.steps).includes("insurance_minimum_minor"),
      ),
    ).toBeDefined();
    expect((await repo.addRequirement(db, "o1", { kind: "Equipment", description: "x" })).ok).toBe(
      false,
    );
    expect(await repo.removeOpportunityChild(db, "opportunity_requirements", "rq")).toEqual({
      ok: true,
      data: null,
    });
    expect(await repo.addInvitation(db, "o1", { personId: "ivy" })).toEqual({
      ok: true,
      data: { id: "inv" },
    });
    expect(await repo.addInvitation(db, "o1", { organizationId: "acct" })).toEqual({
      ok: true,
      data: { id: "inv2" },
    });
    expect((await repo.addInvitation(db, "o1", { personId: "x" })).ok).toBe(false);
    expect(
      (
        await repo.removeOpportunityChild(
          client({ "from:opportunity_positions": [hidden] }).db,
          "opportunity_positions",
          "x",
        )
      ).ok,
    ).toBe(false);
  });
});

describe("opportunities repository: pipeline and offers", () => {
  it("lists and reads applications from the board", async () => {
    const { db } = client({
      "from:application_board": [
        okResponse([BOARD]),
        okResponse(BOARD),
        okResponse(null),
        hidden,
        hidden,
      ],
    });
    const list = await repo.listApplications(db, "org", { opportunityId: "o1", projectId: "p1" });
    expect(list.ok && list.data[0]).toMatchObject({
      applicantName: "Ivy Marchetti",
      bidSealed: true,
      bidTotalMinor: null,
      shortlistRank: 1,
    });
    expect((await repo.getApplication(db, "a1")).ok).toBe(true);
    expect(await repo.getApplication(db, "a1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await repo.listApplications(db, "org")).ok).toBe(false);
    expect((await repo.getApplication(db, "a1")).ok).toBe(false);
  });

  it("maps an empty board row to safe defaults", async () => {
    const { db } = client({ "from:application_board": [okResponse([{ application_kind: null }])] });
    const list = await repo.listApplications(db, "org");
    expect(list.ok && list.data[0]).toMatchObject({
      id: "",
      state: "Submitted",
      applicantKind: "Person",
      hasBid: false,
    });
  });

  it("reads answers in question order and interviews", async () => {
    const { db } = client({
      "from:application_answers": [
        okResponse([
          {
            id: "x2",
            opportunity_question_id: "q2",
            answer_text: "B",
            question: { prompt: "Second", sort_order: 2 },
          },
          {
            id: "x1",
            opportunity_question_id: "q1",
            answer_text: "A",
            question: { prompt: "First", sort_order: 1 },
          },
          { id: "x3", opportunity_question_id: "q3", answer_text: "C", question: null },
        ]),
        hidden,
      ],
      "from:interviews": [
        okResponse([
          {
            id: "i1",
            interview_kind: "Audition",
            scheduled_at: "2027-05-01T10:00:00Z",
            duration_minutes: 30,
            location_text: null,
            internal_note: "Strong.",
          },
        ]),
        hidden,
        okResponse({ id: "i2" }),
        hidden,
      ],
    });
    const answers = await repo.listApplicationAnswers(db, "a1");
    expect(answers.ok && answers.data.map((a) => a.prompt)).toEqual(["", "First", "Second"]);
    expect((await repo.listApplicationAnswers(db, "a1")).ok).toBe(false);
    expect((await repo.listInterviews(db, "a1")).ok && true).toBe(true);
    expect((await repo.listInterviews(db, "a1")).ok).toBe(false);
    expect(
      await repo.scheduleInterview(db, "a1", {
        kind: "Interview",
        scheduledAt: "2027-05-02T10:00:00Z",
        durationMinutes: 45,
      }),
    ).toEqual({
      ok: true,
      data: { id: "i2" },
    });
    expect(
      (
        await repo.scheduleInterview(db, "a1", {
          kind: "Interview",
          scheduledAt: "x",
          durationMinutes: 1,
        })
      ).ok,
    ).toBe(false);
  });

  it("moves applications and ranks the shortlist", async () => {
    const { db, calls } = client({
      "rpc:transition_application": [okResponse("t"), refusal],
      "from:shortlists": [
        okResponse(null),
        okResponse(null),
        okResponse({ id: "s1" }),
        okResponse(null),
        hidden,
        okResponse(null),
        hidden,
      ],
    });
    expect(
      await repo.transitionApplication(db, "a1", "Submitted", "In Review", "Screening."),
    ).toEqual({ ok: true, data: "t" });
    expect((await repo.transitionApplication(db, "a1", "In Review", "Offered", "Skip.")).ok).toBe(
      false,
    );
    expect(
      await repo.setShortlistRank(db, { opportunityId: "o1", applicationId: "a1", rank: 1 }),
    ).toEqual({ ok: true, data: null });
    expect(
      await repo.setShortlistRank(db, {
        opportunityId: "o1",
        applicationId: "a1",
        rank: 2,
        note: "Top.",
      }),
    ).toEqual({ ok: true, data: null });
    expect(calls.filter((c) => c.target === "from:shortlists").map((c) => c.steps[0]?.[0])).toEqual(
      ["select", "insert", "select", "update"],
    );
    expect(
      (await repo.setShortlistRank(db, { opportunityId: "o1", applicationId: "a1", rank: 1 })).ok,
    ).toBe(false);
    expect(
      (await repo.setShortlistRank(db, { opportunityId: "o1", applicationId: "a1", rank: 1 })).ok,
    ).toBe(false);
  });

  it("sends, revises, accepts and withdraws offers", async () => {
    const terms = {
      rateType: "Day" as const,
      amountMinor: 90000,
      currencyCode: "USD",
      startsOn: null,
      endsOn: null,
      message: "Welcome.",
      expiresAt: null,
    };
    const { db, calls } = client({
      "rpc:send_offer": [okResponse("of1")],
      "rpc:revise_offer": [okResponse("v2")],
      "rpc:accept_offer": [okResponse(null), refusal],
      "rpc:withdraw_offer": [okResponse(null)],
      "rpc:create_engagement_from_application": [okResponse("e1")],
      "from:offer_versions": [
        okResponse([
          {
            id: "v1",
            version_number: 1,
            proposed_side: "Organization",
            rate_type: "Day",
            amount_minor: 90000,
            currency_code: "USD",
            starts_on: null,
            ends_on: null,
            message: null,
            expires_at: null,
            created_at: "t",
          },
        ]),
        hidden,
      ],
    });
    expect(await repo.sendOffer(db, "a1", terms)).toEqual({ ok: true, data: "of1" });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toMatchObject({
      p_application_id: "a1",
      p_amount_minor: 90000,
      p_expires_at: null,
    });
    expect(await repo.reviseOffer(db, "of1", { ...terms, amountMinor: 95000 })).toEqual({
      ok: true,
      data: "v2",
    });
    expect(await repo.acceptOffer(db, "of1")).toEqual({ ok: true, data: null });
    expect(await repo.acceptOffer(db, "of1")).toMatchObject({
      ok: false,
      error: { kind: "refusal" },
    });
    expect(await repo.withdrawOffer(db, "of1", "Budget.")).toEqual({ ok: true, data: null });
    expect((await repo.listOfferVersions(db, "of1")).ok).toBe(true);
    expect((await repo.listOfferVersions(db, "of1")).ok).toBe(false);
    expect(
      await repo.createEngagementFromApplication(db, {
        applicationId: "a1",
        workerClassification: "INDEPENDENT_CONTRACTOR",
        payBasis: "Day Rate",
        arrangement: "Per Engagement",
      }),
    ).toEqual({ ok: true, data: "e1" });
  });
});

describe("opportunities repository: engagements", () => {
  it("lists and reads engagements from the board", async () => {
    const { db } = client({
      "from:engagement_board": [
        okResponse([ENGAGEMENT]),
        okResponse(ENGAGEMENT),
        okResponse(null),
        hidden,
        hidden,
        okResponse([{}]),
      ],
    });
    const list = await repo.listEngagements(db, "org", { projectId: "p1", states: ["Onboarding"] });
    expect(list.ok && list.data[0]).toMatchObject({
      partyName: "Ivy Marchetti",
      openBlockingCount: 2,
      documentsInFlight: 1,
    });
    expect((await repo.getEngagement(db, "e1")).ok).toBe(true);
    expect(await repo.getEngagement(db, "e1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await repo.listEngagements(db, "org")).ok).toBe(false);
    expect((await repo.getEngagement(db, "e1")).ok).toBe(false);
    const blank = await repo.listEngagements(db, "org");
    expect(blank.ok && blank.data[0]).toMatchObject({
      id: "",
      state: "Onboarding",
      openBlockingCount: 0,
    });
  });

  it("reads the rate masked or in force", async () => {
    const { db } = client({
      "from:engagement_resolved": [
        okResponse({
          rate_minor: null,
          rate_currency_code: "USD",
          is_masked: true,
          pay_basis: "Day Rate",
          arrangement: "Per Engagement",
        }),
        okResponse(null),
        hidden,
      ],
    });
    expect(await repo.getEngagementRate(db, "e1")).toEqual({
      ok: true,
      data: {
        rateMinor: null,
        currencyCode: "USD",
        masked: true,
        payBasis: "Day Rate",
        arrangement: "Per Engagement",
      },
    });
    expect(await repo.getEngagementRate(db, "e1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await repo.getEngagementRate(db, "e1")).ok).toBe(false);
  });

  it("moves engagements and their documents and issues signing links", async () => {
    const { db } = client({
      "rpc:transition_engagement": [
        errorResponse("XR001", "onboarding_incomplete: Every blocking onboarding item must pass."),
      ],
      "rpc:transition_engagement_document": [okResponse("t")],
      "rpc:issue_engagement_document_token": [
        okResponse([
          {
            token_id: "k",
            token: "xdoc_1",
            access_code: "123456",
            expires_at: "2027-01-01T00:00:00Z",
          },
        ]),
        okResponse([]),
        refusal,
      ],
      "from:engagement_documents": [
        okResponse([
          {
            id: "d1",
            document_kind: "Agreement",
            title: "Crew Agreement",
            engagement_document_state: "Proposed",
            expires_on: null,
          },
        ]),
        hidden,
        okResponse({ id: "d2" }),
        hidden,
      ],
    });
    expect(await repo.transitionEngagement(db, "e1", "Onboarding", "Active", "Go.")).toMatchObject({
      ok: false,
      error: { rule: "onboarding_incomplete" },
    });
    expect(await repo.transitionEngagementDocument(db, "d1", "Proposed", "Sent", "Out.")).toEqual({
      ok: true,
      data: "t",
    });
    expect(await repo.issueSigningLink(db, "d1", "ivy@freelance.test", 14)).toEqual({
      ok: true,
      data: {
        tokenId: "k",
        token: "xdoc_1",
        accessCode: "123456",
        expiresAt: "2027-01-01T00:00:00Z",
      },
    });
    expect(await repo.issueSigningLink(db, "d1", "ivy@freelance.test", 14)).toMatchObject({
      ok: false,
      error: { kind: "unexpected" },
    });
    expect((await repo.issueSigningLink(db, "d1", "x", 14)).ok).toBe(false);
    expect((await repo.listEngagementDocuments(db, "e1")).ok).toBe(true);
    expect((await repo.listEngagementDocuments(db, "e1")).ok).toBe(false);
    expect(
      await repo.createEngagementDocument(db, {
        engagementId: "e1",
        kind: "Rider",
        title: "Rider",
      }),
    ).toEqual({ ok: true, data: { id: "d2" } });
    expect(
      (
        await repo.createEngagementDocument(db, {
          engagementId: "e1",
          kind: "Rider",
          title: "Rider",
        })
      ).ok,
    ).toBe(false);
  });

  it("reads onboarding status and verifies items", async () => {
    const status = {
      onboarding_item_id: "i1",
      engagement_id: "e1",
      onboarding_requirement_id: "r1",
      name: "Certificate of Insurance",
      item_kind: "Document Upload",
      is_blocking: true,
      verification_method: "Reviewer",
      submitted_at: null,
      latest_outcome: null,
      expires_on: null,
      passes: false,
      carried_over: false,
      reminder_due: false,
    };
    const { db } = client({
      "from:onboarding_item_status": [okResponse([status]), okResponse([{}]), hidden],
      "from:onboarding_verifications": [
        okResponse(null),
        errorResponse("XR001", "sod_onboarding_self_verify: no"),
      ],
    });
    expect((await repo.listOnboardingStatus(db, { engagementId: "e1", orgId: "org" })).ok).toBe(
      true,
    );
    const blank = await repo.listOnboardingStatus(db, {});
    expect(blank.ok && blank.data[0]).toMatchObject({
      kind: "Form",
      method: "Reviewer",
      passes: false,
    });
    expect((await repo.listOnboardingStatus(db, {})).ok).toBe(false);
    expect(await repo.verifyOnboardingItem(db, { itemId: "i1", outcome: "Passed" })).toEqual({
      ok: true,
      data: null,
    });
    expect(
      await repo.verifyOnboardingItem(db, { itemId: "i1", outcome: "Passed", note: "Self." }),
    ).toMatchObject({
      ok: false,
      error: { rule: "sod_onboarding_self_verify" },
    });
  });

  it("reads deliverables and decides them", async () => {
    const { db } = client({
      "from:engagement_deliverables": [
        okResponse([
          {
            id: "dl",
            record_id: "rec",
            deliverable_state: "Submitted",
            submitted_at: "t",
            submission_message: "Done.",
            return_reason: null,
            record: { title: "Stage Plot" },
          },
        ]),
        okResponse([
          {
            id: "dl2",
            record_id: "rec2",
            deliverable_state: "Open",
            submitted_at: null,
            submission_message: null,
            return_reason: null,
            record: null,
          },
        ]),
        hidden,
      ],
      "rpc:decide_deliverable": [okResponse("t")],
    });
    expect((await repo.listDeliverables(db, "e1")).ok && true).toBe(true);
    const blank = await repo.listDeliverables(db, "e1");
    expect(blank.ok && blank.data[0]?.title).toBeNull();
    expect((await repo.listDeliverables(db, "e1")).ok).toBe(false);
    expect(await repo.decideDeliverable(db, "dl", "Approved", null)).toEqual({
      ok: true,
      data: null,
    });
  });
});

describe("opportunities repository: ratings, requirements, pools and settings", () => {
  it("lists ratings with replies, rates and replies", async () => {
    const { db } = client({
      "from:ratings": [
        okResponse([
          {
            id: "rt",
            engagement_id: "e1",
            rater_side: "Party",
            score: 5,
            comment: "Clear.",
            submitted_at: "t",
            replies: [{ body: "Thank you.", deleted_at: null }],
          },
          {
            id: "rt2",
            engagement_id: "e2",
            rater_side: "Organization",
            score: 4,
            comment: null,
            submitted_at: "t",
            replies: null,
          },
        ]),
        hidden,
        okResponse(null),
        errorResponse("XR001", "rating_engagement_not_complete: no"),
      ],
      "from:rating_replies": [okResponse(null), hidden],
    });
    const list = await repo.listRatings(db, "org");
    expect(list.ok && list.data.map((r) => r.reply)).toEqual(["Thank you.", null]);
    expect((await repo.listRatings(db, "org")).ok).toBe(false);
    expect(await repo.rateParty(db, { engagementId: "e1", score: 4 })).toEqual({
      ok: true,
      data: null,
    });
    expect(await repo.rateParty(db, { engagementId: "e1", score: 4, comment: "x" })).toMatchObject({
      ok: false,
      error: { kind: "refusal" },
    });
    expect(await repo.replyToRating(db, "rt", "Thanks.")).toEqual({ ok: true, data: null });
    expect((await repo.replyToRating(db, "rt", "x")).ok).toBe(false);
  });

  it("lists and creates onboarding requirements", async () => {
    const { db } = client({
      "from:onboarding_requirements": [
        okResponse([
          {
            id: "r1",
            name: "W-9",
            item_kind: "Tax Form",
            role_type: null,
            jurisdiction_id: null,
            verification_method: "Reviewer",
            is_blocking: true,
            valid_for_days: null,
            remind_days_before: null,
          },
        ]),
        hidden,
        okResponse({ id: "r2" }),
        hidden,
      ],
    });
    expect((await repo.listOnboardingRequirements(db, "org")).ok).toBe(true);
    expect((await repo.listOnboardingRequirements(db, "org")).ok).toBe(false);
    const input = {
      orgId: "org",
      name: "COI",
      kind: "Document Upload" as const,
      method: "Reviewer" as const,
      blocking: true,
    };
    expect(await repo.createOnboardingRequirement(db, input)).toEqual({
      ok: true,
      data: { id: "r2" },
    });
    expect((await repo.createOnboardingRequirement(db, input)).ok).toBe(false);
  });

  it("manages pools and names their members", async () => {
    const { db } = client({
      "from:talent_pools": [
        okResponse([
          {
            id: "tp",
            name: "Riggers",
            pool_kind: "Talent",
            members: [
              { id: "m", deleted_at: null },
              { id: "m2", deleted_at: "x" },
            ],
          },
        ]),
        hidden,
        okResponse({ id: "tp2" }),
        hidden,
      ],
      "from:pool_members": [
        okResponse([
          {
            id: "m",
            talent_pool_id: "tp",
            person_id: "ivy",
            organization_id: null,
            standing: "Preferred",
            reason: null,
            review_on: null,
          },
          {
            id: "m3",
            talent_pool_id: "tp",
            person_id: null,
            organization_id: "acct",
            standing: "Approved",
            reason: null,
            review_on: null,
          },
        ]),
        okResponse([]),
        hidden,
        okResponse([
          {
            id: "m",
            talent_pool_id: "tp",
            person_id: "ivy",
            organization_id: null,
            standing: "Preferred",
            reason: null,
            review_on: null,
          },
        ]),
        okResponse([
          {
            id: "m",
            talent_pool_id: "tp",
            person_id: "ivy",
            organization_id: null,
            standing: "Preferred",
            reason: null,
            review_on: null,
          },
        ]),
        okResponse({ id: "m4" }),
        hidden,
        okResponse(null),
        hidden,
        okResponse(null),
        hidden,
      ],
      "from:engagement_board": [
        okResponse([
          { person_id: "ivy", account_id: null, party_name: "Ivy Marchetti", account_name: null },
        ]),
        hidden,
        okResponse([]),
      ],
      "from:application_board": [
        okResponse([
          {
            applicant_person_id: null,
            applicant_organization_id: "acct",
            applicant_name: "Bayside Audio",
          },
        ]),
        okResponse([]),
        hidden,
      ],
    });
    const pools = await repo.listPools(db, "org");
    expect(pools.ok && pools.data[0]?.memberCount).toBe(1);
    expect((await repo.listPools(db, "org")).ok).toBe(false);
    expect(await repo.createPool(db, { orgId: "org", name: "Audio", kind: "Vendor" })).toEqual({
      ok: true,
      data: { id: "tp2" },
    });
    expect((await repo.createPool(db, { orgId: "org", name: "Audio", kind: "Vendor" })).ok).toBe(
      false,
    );
    const members = await repo.listPoolMembers(db, "tp");
    expect(members.ok && members.data.map((m) => m.name)).toEqual([
      "Ivy Marchetti",
      "Bayside Audio",
    ]);
    expect(await repo.listPoolMembers(db, "tp")).toEqual({ ok: true, data: [] });
    expect((await repo.listPoolMembers(db, "tp")).ok).toBe(false);
    expect((await repo.listPoolMembers(db, "tp")).ok).toBe(false);
    expect((await repo.listPoolMembers(db, "tp")).ok).toBe(false);
    expect(
      await repo.addPoolMember(db, {
        poolId: "tp",
        party: { personId: "quinn" },
        standing: "Do Not Engage",
        reason: "No-show.",
        reviewOn: "2027-01-01",
      }),
    ).toEqual({
      ok: true,
      data: { id: "m4" },
    });
    expect(
      (
        await repo.addPoolMember(db, {
          poolId: "tp",
          party: { organizationId: "acct" },
          standing: "Approved",
        })
      ).ok,
    ).toBe(false);
    expect(await repo.setPoolStanding(db, "m", { standing: "Approved" })).toEqual({
      ok: true,
      data: null,
    });
    expect((await repo.setPoolStanding(db, "m", { standing: "Approved" })).ok).toBe(false);
    expect(await repo.removePoolMember(db, "m")).toEqual({ ok: true, data: null });
    expect((await repo.removePoolMember(db, "m")).ok).toBe(false);
  });

  it("reads listing reports and pay transparency rules", async () => {
    const { db } = client({
      "from:listing_reports": [
        okResponse([
          {
            id: "lr",
            opportunity_id: "o1",
            reason: "Missing Pay Range",
            details: null,
            reported_at: "t",
            opportunity: { title: "Riggers" },
          },
        ]),
        okResponse([
          {
            id: "lr2",
            opportunity_id: "o2",
            reason: "Fraud",
            details: "x",
            reported_at: "t",
            opportunity: null,
          },
        ]),
        hidden,
      ],
      "from:pay_transparency_rules": [
        okResponse([
          {
            jurisdiction_id: "US-CO",
            requires_pay_range: true,
            effective_from: "2021-01-01",
            citation: "Statute",
          },
        ]),
        okResponse([{}]),
        hidden,
      ],
    });
    expect((await repo.listListingReports(db, "org")).ok && true).toBe(true);
    const blank = await repo.listListingReports(db, "org");
    expect(blank.ok && blank.data[0]?.opportunityTitle).toBeNull();
    expect((await repo.listListingReports(db, "org")).ok).toBe(false);
    expect(await repo.listPayTransparencyRules(db)).toEqual({
      ok: true,
      data: [
        {
          jurisdictionId: "US-CO",
          requiresPayRange: true,
          effectiveFrom: "2021-01-01",
          citation: "Statute",
        },
      ],
    });
    const blankRule = await repo.listPayTransparencyRules(db);
    expect(blankRule.ok && blankRule.data[0]).toEqual({
      jurisdictionId: "",
      requiresPayRange: false,
      effectiveFrom: "",
      citation: "",
    });
    expect((await repo.listPayTransparencyRules(db)).ok).toBe(false);
  });
});
