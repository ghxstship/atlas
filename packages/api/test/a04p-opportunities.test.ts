/**
 * A04P contract tests for the Opportunities operations ADR 0023 opened and the People offers block.
 * Requests run through `contractApp` against the in-memory client; every response is checked
 * against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers as opportunities } from "../src/handlers/opportunities.ts";
import { handlers as people } from "../src/handlers/people.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const AUDIT = {
  org_id: ORG,
  created_at: "2026-10-01T12:00:00.000Z",
  created_by: null,
  updated_at: "2026-10-01T12:00:00.000Z",
  updated_by: null,
  deleted_at: null,
};
const OPP = id(7001);
const APP = id(7101);
const BID = id(7201);
const OFFER = id(7301);
const PERSON = id(7401);

/** A stored row: the contract sample with the audit columns and `deleted_at`. */
function seed(component: string, rowId: string, extra: Row = {}): Row {
  return { ...sample(component, { id: rowId, ...AUDIT, ...extra }), deleted_at: null };
}

function world() {
  const db = memoryDb(
    {
      opportunities: [seed("Opportunity", OPP, { opportunity_state: "Draft", deadline_at: null })],
      opportunity_positions: [seed("OpportunityPosition", id(7002), { opportunity_id: OPP })],
      opportunity_requirements: [seed("OpportunityRequirement", id(7003), { opportunity_id: OPP })],
      applications: [
        seed("Application", APP, {
          opportunity_id: OPP,
          application_state: "In Review",
          applicant_person_id: PERSON,
          applicant_organization_id: null,
        }),
      ],
      bids: [
        {
          id: BID,
          ...AUDIT,
          application_id: APP,
          currency_code: "USD",
          valid_until: null,
          submitted_at: "2026-10-01T12:00:00.000Z",
        },
      ],
      bid_lines: [
        { id: id(7211), bid_id: BID, quantity: 2, unit_price_minor: 15000, deleted_at: null },
        { id: id(7212), bid_id: BID, quantity: 1, unit_price_minor: null, deleted_at: null },
      ],
      interviews: [seed("Interview", id(7004), { application_id: APP })],
      engagement_documents: [
        seed("EngagementDocument", id(7005), { engagement_document_state: "Draft" }),
      ],
      onboarding_requirements: [seed("OnboardingRequirement", id(7006))],
      talent_pools: [seed("TalentPool", id(7007))],
      onboarding_verifications: [
        {
          id: id(7008),
          ...AUDIT,
          onboarding_item_id: id(7009),
          outcome: "Passed",
          verified_by: null,
          verified_at: "2026-10-01T12:00:00.000Z",
          note: "Certificate on file.",
        },
      ],
      agency_slates: [{ id: id(7010), ...AUDIT, application_id: APP, person_id: PERSON }],
      offers: [{ id: OFFER, ...AUDIT, application_id: APP, offer_state: "Sent" }],
      offer_versions: [
        {
          id: id(7311),
          offer_id: OFFER,
          version_number: 1,
          proposed_side: "Organization",
          rate_type: "Day",
          amount_minor: 45000,
          currency_code: "USD",
          starts_on: "2027-03-10",
          ends_on: "2027-03-15",
          message: "Welcome aboard.",
          expires_at: null,
          deleted_at: null,
        },
      ],
      offer_state_transitions: [],
    },
    {
      transition_opportunity: (args, self) => {
        const row = self.tables["opportunities"]?.find((r) => r["id"] === args["p_opportunity_id"]);
        if (!row || row["opportunity_state"] !== args["p_expected"]) throw refusal("stale_state");
        row["opportunity_state"] = args["p_next"];
        return args["p_next"];
      },
      transition_application: (args, self) => {
        const row = self.tables["applications"]?.find((r) => r["id"] === args["p_application_id"]);
        if (row) row["application_state"] = args["p_next"];
        return args["p_next"];
      },
      transition_engagement_document: (args, self) => {
        const row = self.tables["engagement_documents"]?.find(
          (r) => r["id"] === args["p_document_id"],
        );
        if (row) row["engagement_document_state"] = args["p_next"];
        return args["p_next"];
      },
      send_offer: (args, self) => {
        const offer = id(7302);
        self.tables["offers"]?.push({
          id: offer,
          ...AUDIT,
          application_id: args["p_application_id"],
          offer_state: "Sent",
        });
        self.tables["offer_versions"]?.push({
          id: id(7321),
          offer_id: offer,
          version_number: 1,
          proposed_side: "Organization",
          rate_type: args["p_rate_type"],
          amount_minor: args["p_amount_minor"],
          currency_code: args["p_currency_code"],
          starts_on: args["p_starts_on"],
          ends_on: args["p_ends_on"],
          message: args["p_message"],
          expires_at: args["p_expires_at"],
          deleted_at: null,
        });
        return offer;
      },
      revise_offer: (args, self) => addVersion(self.tables, args, "Organization", "Sent"),
      counter_offer: (args, self) => addVersion(self.tables, args, "Party", "Countered"),
      accept_offer: (args, self) => respond(self.tables, args, "Accepted"),
      decline_offer: (args, self) => respond(self.tables, args, "Declined"),
      withdraw_offer: (args, self) => respond(self.tables, args, "Withdrawn"),
    },
    {
      opportunities: { opportunity_state: "Draft" },
      applications: { application_state: "Submitted" },
      bids: { submitted_at: "2026-10-02T09:00:00.000Z" },
      engagement_documents: { engagement_document_state: "Draft" },
    },
  );
  const app = contractApp({ handlers: [opportunities, people], db });
  return { db, http: requests(app) };
}

function addVersion(tables: Record<string, Row[]>, args: Row, side: string, state: string) {
  const versions = (tables["offer_versions"] ?? []).filter(
    (v) => v["offer_id"] === args["p_offer_id"],
  );
  const next = Math.max(...versions.map((v) => Number(v["version_number"]))) + 1;
  tables["offer_versions"]?.push({
    id: id(7330 + next),
    offer_id: args["p_offer_id"],
    version_number: next,
    proposed_side: side,
    rate_type: args["p_rate_type"],
    amount_minor: args["p_amount_minor"],
    currency_code: args["p_currency_code"],
    starts_on: args["p_starts_on"],
    ends_on: args["p_ends_on"],
    message: args["p_message"],
    expires_at: args["p_expires_at"] ?? null,
    deleted_at: null,
  });
  respond(tables, args, state);
  return id(7330 + next);
}

function respond(tables: Record<string, Row[]>, args: Row, state: string) {
  const offer = tables["offers"]?.find((o) => o["id"] === args["p_offer_id"]) as Row;
  tables["offer_state_transitions"]?.push({
    id: id(7390 + (tables["offer_state_transitions"]?.length ?? 0)),
    offer_id: offer["id"],
    to_state: state,
    created_at: "2026-10-03T10:00:00.000Z",
    deleted_at: null,
  });
  offer["offer_state"] = state;
  return null;
}

describe("opportunities", () => {
  it("serves opportunities and moves one through its lifecycle", async () => {
    const { db, http } = world();
    const listed = await http.get("/opportunities");
    await expectContract(await success(listed), "opportunities.list");
    const read = await http.get(`/opportunities/${OPP}`);
    await expectContract(await success(read), "opportunities.get");
    const made = await http.post("/opportunities", sample("OpportunityCreate"));
    await expectContract(await success(made), "opportunities.create");
    const edited = await http.patch(`/opportunities/${OPP}`, { title: "Riggers For Load-In" });
    await expectContract(await success(edited), "opportunities.update");
    const moved = await http.post(`/opportunities/${OPP}/transitions`, {
      expected_state: "Draft",
      to_state: "Pending Approval",
    });
    const row = (await expectContract(await success(moved), "opportunities.transition")) as Row;
    expect(row["opportunity_state"]).toBe("Pending Approval");
    const stale = await http.post(`/opportunities/${OPP}/transitions`, {
      expected_state: "Draft",
      to_state: "Pending Approval",
    });
    expect(stale.status).toBe(422);
    const removed = await http.delete(`/opportunities/${OPP}`);
    await expectContract(await success(removed), "opportunities.delete");
    expect(db.calls.filter((c) => c.name === "transition_opportunity")).toHaveLength(2);
  });

  it("serves positions and requirements", async () => {
    const { http } = world();
    const positions = await http.get(`/opportunity-positions?filter[opportunity_id][eq]=${OPP}`);
    await expectContract(await success(positions), "opportunityPositions.list");
    const position = await http.get(`/opportunity-positions/${id(7002)}`);
    await expectContract(await success(position), "opportunityPositions.get");
    const addedPosition = await http.post(
      "/opportunity-positions",
      sample("OpportunityPositionCreate", { opportunity_id: OPP }),
    );
    await expectContract(await success(addedPosition), "opportunityPositions.create");
    const editedPosition = await http.patch(`/opportunity-positions/${id(7002)}`, {
      label: "Head Rigger",
    });
    await expectContract(await success(editedPosition), "opportunityPositions.update");
    const removedPosition = await http.delete(`/opportunity-positions/${id(7002)}`);
    await expectContract(await success(removedPosition), "opportunityPositions.delete");

    const requirements = await http.get("/opportunity-requirements");
    await expectContract(await success(requirements), "opportunityRequirements.list");
    const requirement = await http.get(`/opportunity-requirements/${id(7003)}`);
    await expectContract(await success(requirement), "opportunityRequirements.get");
    const addedRequirement = await http.post(
      "/opportunity-requirements",
      sample("OpportunityRequirementCreate", { opportunity_id: OPP }),
    );
    await expectContract(await success(addedRequirement), "opportunityRequirements.create");
    const editedRequirement = await http.patch(`/opportunity-requirements/${id(7003)}`, {
      description: "Own harness.",
    });
    await expectContract(await success(editedRequirement), "opportunityRequirements.update");
    const removedRequirement = await http.delete(`/opportunity-requirements/${id(7003)}`);
    await expectContract(await success(removedRequirement), "opportunityRequirements.delete");
  });
});

describe("applications, bids and interviews", () => {
  it("serves applications and moves one", async () => {
    const { http } = world();
    const listed = await http.get("/applications");
    await expectContract(await success(listed), "applications.list");
    const read = await http.get(`/applications/${APP}`);
    await expectContract(await success(read), "applications.get");
    const made = await http.post("/applications", sample("ApplicationCreate"));
    await expectContract(await success(made), "applications.create");
    const moved = await http.post(`/applications/${APP}/transitions`, {
      expected_state: "In Review",
      to_state: "Shortlisted",
    });
    const row = (await expectContract(await success(moved), "applications.transition")) as Row;
    expect(row["application_state"]).toBe("Shortlisted");
  });

  it("derives a bid's total from its lines and its seal from the deadline", async () => {
    const { http } = world();
    const listed = await http.get("/bids");
    const page = (await expectContract(await success(listed), "bids.list")) as { data: Row[] };
    expect(page.data[0]?.["total"]).toEqual({
      total_minor: null,
      currency: "USD",
      unpriced_count: 1,
    });
    expect(page.data[0]?.["sealed"]).toBe(true);
    const read = await http.get(`/bids/${BID}`);
    await expectContract(await success(read), "bids.get");
    const made = await http.post("/bids", { application_id: APP, currency_code: "EUR" });
    const bid = (await expectContract(await success(made), "bids.create")) as Row;
    expect(bid["total"]).toEqual({ total_minor: 0, currency: "EUR", unpriced_count: 0 });
    const edited = await http.patch(`/bids/${BID}`, { valid_until: "2027-01-31" });
    await expectContract(await success(edited), "bids.update");
  });

  it("serves interviews", async () => {
    const { http } = world();
    const listed = await http.get("/interviews");
    await expectContract(await success(listed), "interviews.list");
    const read = await http.get(`/interviews/${id(7004)}`);
    await expectContract(await success(read), "interviews.get");
    const made = await http.post("/interviews", sample("InterviewCreate", { application_id: APP }));
    await expectContract(await success(made), "interviews.create");
    const edited = await http.patch(`/interviews/${id(7004)}`, { duration_minutes: 45 });
    await expectContract(await success(edited), "interviews.update");
    const removed = await http.delete(`/interviews/${id(7004)}`);
    await expectContract(await success(removed), "interviews.delete");
  });

  it("creates and removes agency slates", async () => {
    const { http } = world();
    const made = await http.post("/agency-slates", { application_id: APP, person_id: id(7402) });
    await expectContract(await success(made), "agencySlates.create");
    const removed = await http.delete(`/agency-slates/${id(7010)}`);
    await expectContract(await success(removed), "agencySlates.delete");
  });
});

describe("engagement documents, onboarding and pools", () => {
  it("serves engagement documents and moves one", async () => {
    const { http } = world();
    const listed = await http.get("/engagement-documents");
    await expectContract(await success(listed), "engagementDocuments.list");
    const read = await http.get(`/engagement-documents/${id(7005)}`);
    await expectContract(await success(read), "engagementDocuments.get");
    const made = await http.post("/engagement-documents", sample("EngagementDocumentCreate"));
    await expectContract(await success(made), "engagementDocuments.create");
    const moved = await http.post(`/engagement-documents/${id(7005)}/transitions`, {
      expected_state: "Draft",
      to_state: "Sent",
    });
    await expectContract(await success(moved), "engagementDocuments.transition");
  });

  it("serves onboarding requirements and verifications", async () => {
    const { http } = world();
    const listed = await http.get("/onboarding-requirements");
    await expectContract(await success(listed), "onboardingRequirements.list");
    const read = await http.get(`/onboarding-requirements/${id(7006)}`);
    await expectContract(await success(read), "onboardingRequirements.get");
    const made = await http.post("/onboarding-requirements", sample("OnboardingRequirementCreate"));
    await expectContract(await success(made), "onboardingRequirements.create");
    const edited = await http.patch(`/onboarding-requirements/${id(7006)}`, { name: "W-9" });
    await expectContract(await success(edited), "onboardingRequirements.update");
    const removed = await http.delete(`/onboarding-requirements/${id(7006)}`);
    await expectContract(await success(removed), "onboardingRequirements.delete");

    const verifications = await http.get("/onboarding-verifications");
    const page = (await expectContract(
      await success(verifications),
      "onboardingVerifications.list",
    )) as { data: Row[] };
    expect(page.data[0]?.["passed"]).toBe(true);
    const verification = await http.get(`/onboarding-verifications/${id(7008)}`);
    const one = (await expectContract(
      await success(verification),
      "onboardingVerifications.get",
    )) as Row;
    expect(one["notes"]).toBe("Certificate on file.");
  });

  it("serves talent pools", async () => {
    const { http } = world();
    const listed = await http.get("/talent-pools");
    await expectContract(await success(listed), "talentPools.list");
    const read = await http.get(`/talent-pools/${id(7007)}`);
    await expectContract(await success(read), "talentPools.get");
    const made = await http.post("/talent-pools", { name: "Riggers", pool_kind: "Talent" });
    await expectContract(await success(made), "talentPools.create");
    const edited = await http.patch(`/talent-pools/${id(7007)}`, { name: "Lead Riggers" });
    await expectContract(await success(edited), "talentPools.update");
    const removed = await http.delete(`/talent-pools/${id(7007)}`);
    await expectContract(await success(removed), "talentPools.delete");
  });
});

describe("offers", () => {
  it("reads an offer with the terms in force", async () => {
    const { http } = world();
    const listed = await http.get("/offers");
    const page = (await expectContract(await success(listed), "offers.list")) as { data: Row[] };
    expect(page.data[0]).toMatchObject({
      version_number: 1,
      amount_minor: 45000,
      person_id: PERSON,
      responded_at: null,
    });
    const read = await http.get(`/offers/${OFFER}`);
    await expectContract(await success(read), "offers.get");
  });

  it("sends, revises, counters and answers offers", async () => {
    const { db, http } = world();
    const sent = await http.post("/offers", {
      application_id: APP,
      rate_type: "Day",
      amount_minor: 50000,
      currency_code: "USD",
      starts_on: "2027-03-10",
      ends_on: "2027-03-15",
    });
    const offer = (await expectContract(await success(sent), "offers.create")) as Row;
    expect(offer["amount_minor"]).toBe(50000);

    const countered = await http.post(`/offers/${OFFER}/counter`, { amount_minor: 52000 });
    const counter = (await expectContract(await success(countered), "offers.counter")) as Row;
    expect(counter).toMatchObject({
      proposed_side: "Party",
      amount_minor: 52000,
      currency_code: "USD",
      offer_state: "Countered",
    });
    expect(counter["responded_at"]).not.toBeNull();

    const revised = await http.patch(`/offers/${OFFER}`, { amount_minor: 51000 });
    const revision = (await expectContract(await success(revised), "offers.update")) as Row;
    expect(revision["version_number"]).toBe(3);

    const accepted = await http.post(`/offers/${OFFER}/accept`);
    await expectContract(await success(accepted), "offers.accept");
    const declined = await http.post(`/offers/${OFFER}/decline`, { reason: "Booked elsewhere." });
    await expectContract(await success(declined), "offers.decline");
    const withdrawn = await http.post(`/offers/${OFFER}/withdraw`, { reason: "Show canceled." });
    await expectContract(await success(withdrawn), "offers.withdraw");

    db.fail("rpc:accept_offer", refusal("offer_not_open", "The offer is no longer open."));
    const refused = await http.post(`/offers/${OFFER}/accept`);
    expect(refused.status).toBe(422);
    const missing = await http.post(`/offers/${id(7999)}/accept`);
    expect(missing.status).toBe(404);
  });
});
