import { describe, expect, it } from "vitest";
import {
  approveRequisition,
  bodyHash,
  certificateStatus,
  createAgreement,
  createCertification,
  createRequisition,
  createRoleAssignment,
  getAgreement,
  getCertificationHolder,
  getRequisition,
  getRoleAssignment,
  listAgreements,
  listCertificationHolders,
  listCertifications,
  listDirectory,
  listOffers,
  listPeopleRequisitions,
  listRoleAssignments,
  listWorkforceRoles,
  recordCertificationHolder,
  rejectRequisition,
  removeCertificationHolder,
  requisitionEstimate,
  seatSplit,
  sendAgreement,
  signAgreement,
  staffingHeadcount,
  transitionAgreement,
  transitionRequisition,
  transitionRoleAssignment,
  updateAgreement,
  updateRequisition,
  type DirectoryEntry,
} from "../src/people.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

function client(queues: Record<string, Response[]>) {
  const fake = fakeClient(queues);
  (fake.db as unknown as { schema: () => unknown }).schema = () => fake.db;
  return fake;
}

const denied = () => errorResponse("42501", "denied");
const refused = (rule: string) => errorResponse("XR001", `${rule}: Refused.`, rule);
const ledger = [
  {
    id: "l1",
    from_state: null,
    to_state: "Proposed",
    reason: "Created.",
    created_at: "x",
    created_by: "p1",
  },
];

describe("canon roles and staffing", () => {
  it("reads workforce roles in code order and sizes ratio roles", async () => {
    const { db } = client({
      "from:dim_role": [
        okResponse([
          {
            role_code: "8000.50.01",
            role: "Bartending",
            job_title: null,
            dept_code: "8000",
            staffing_ratio: "65",
            ratio_basis: "guests per person",
            kit_basis: null,
          },
          {
            role_code: "5000.51.01",
            role: "Stagehand",
            job_title: null,
            dept_code: "5000",
            staffing_ratio: null,
            ratio_basis: "fixed per tier",
            kit_basis: "Per event",
          },
        ]),
        denied(),
      ],
    });
    const roles = await listWorkforceRoles(db);
    expect(roles.ok && roles.data.map((r) => [r.code, r.staffingRatio])).toEqual([
      ["5000.51.01", null],
      ["8000.50.01", 65],
    ]);
    expect((await listWorkforceRoles(db)).ok).toBe(false);
    expect(staffingHeadcount(65, 2500)).toBe(39);
    expect(staffingHeadcount(null, 2500)).toBeNull();
    expect(staffingHeadcount(65, 0)).toBeNull();
    expect(requisitionEstimate(3, 8, 3200)).toBe(76800);
    expect(requisitionEstimate(3, null, 3200)).toBeNull();
  });
});

describe("directory", () => {
  it("lists members with roles and counts, and splits seats from Field", async () => {
    const { db } = client({
      "from:memberships": [
        okResponse([
          {
            id: "m2",
            person_id: "p2",
            person: { full_name: "Zed" },
            valid_from: "x",
            membership_roles: [{ deleted_at: null, role: { code: "field", name: null, band: 6 } }],
          },
          {
            id: "m1",
            person_id: "p1",
            person: { full_name: "Ann" },
            valid_from: "x",
            membership_roles: [
              { deleted_at: null, role: { code: "owner", name: null, band: 1 } },
              { deleted_at: "x", role: { code: "viewer", name: null, band: 7 } },
            ],
          },
        ]),
        okResponse([]),
        denied(),
      ],
      "from:role_assignments": [okResponse([{ person_id: "p1" }, { person_id: "p1" }])],
      "from:certification_holders": [okResponse([{ person_id: "p2" }])],
    });
    const result = await listDirectory(db, "o1", new Date("2027-01-01"));
    expect(result.ok && result.data.map((e) => [e.name, e.assignments, e.certifications])).toEqual([
      ["Ann", 2, 0],
      ["Zed", 0, 1],
    ]);
    expect(result.ok && seatSplit(result.data)).toEqual({ seats: 1, field: 1 });
    expect(await listDirectory(db, "o1")).toEqual({ ok: true, data: [] });
    expect((await listDirectory(db, "o1")).ok).toBe(false);
    const viewer = {
      roles: [{ code: "viewer", name: null, band: 7 }],
    } as unknown as DirectoryEntry;
    const none = { roles: [] } as unknown as DirectoryEntry;
    expect(seatSplit([viewer, none])).toEqual({ seats: 0, field: 0 });
  });
});

describe("role assignments", () => {
  const row = {
    id: "a1",
    project_id: "pr1",
    role_code: "8000.50.01",
    person_id: "p1",
    requisition_id: null,
    staffing_basis: "Ratio",
    starts_on: null,
    ends_on: null,
    assignment_state: "Proposed",
    project: { project_key: "NWL" },
    person: { full_name: "Ann" },
  };
  it("lists, reads, creates and moves assignments", async () => {
    const { db } = client({
      "from:role_assignments": [
        okResponse([row, { ...row, id: "a2", role_code: "5000.51.01" }]),
        denied(),
        okResponse(row),
        okResponse(null),
        okResponse({ id: "a1" }),
        refused("role_assignment_person"),
      ],
      "from:role_assignment_state_transitions": [okResponse(ledger)],
      "rpc:transition_role_assignment": [
        okResponse("t1"),
        refused("role_assignment_transition_not_allowed"),
      ],
    });
    const list = await listRoleAssignments(db, {
      orgId: "o1",
      projectId: "pr1",
      personId: "p1",
      roleCode: "8000.50.01",
    });
    expect(list.ok && list.data.map((a) => a.id)).toEqual(["a2", "a1"]);
    expect((await listRoleAssignments(db, { orgId: "o1" })).ok).toBe(false);
    expect((await getRoleAssignment(db, "a1")).ok).toBe(true);
    expect((await getRoleAssignment(db, "x")).ok).toBe(false);
    const input = {
      orgId: "o1",
      projectId: "pr1",
      roleCode: "8000.50.01",
      personId: "p1",
      staffingBasis: "Ratio" as const,
    };
    expect((await createRoleAssignment(db, input)).ok).toBe(true);
    expect((await createRoleAssignment(db, input)).ok).toBe(false);
    expect((await transitionRoleAssignment(db, "a1", "Proposed", "Active", "Go.")).ok).toBe(true);
    expect((await transitionRoleAssignment(db, "a1", "Complete", "Active", "Go.")).ok).toBe(false);
  });
});

describe("requisitions", () => {
  const row = {
    id: "r1",
    project_id: "pr1",
    role_code: "8000.50.01",
    role_type: null,
    worker_classification: "EMPLOYEE",
    pay_basis: "Hourly",
    arrangement: "Per Engagement",
    headcount: 3,
    units_per_head: "8",
    rate_minor: 3200,
    currency_code: "USD",
    starts_on: null,
    ends_on: null,
    justification: "Bars.",
    requested_by: "p1",
    requisition_state: "Proposed",
    created_at: "x",
    project: { project_key: "NWL" },
  };
  const input = {
    roleCode: "8000.50.01",
    roleType: null,
    workerClassification: null,
    payBasis: null,
    arrangement: null,
    headcount: 3,
    unitsPerHead: null,
    rateMinor: null,
    currencyCode: "USD",
    startsOn: null,
    endsOn: null,
    justification: " Bars. ",
  };
  it("lists with estimates, reads with assignments and writes", async () => {
    const { db } = client({
      "from:requisitions": [
        okResponse([row]),
        denied(),
        okResponse(row),
        okResponse(null),
        okResponse({ id: "r1" }),
        denied(),
        okResponse([{ id: "r1" }]),
        refused("requisition_locked"),
      ],
      "from:requisition_state_transitions": [okResponse(ledger)],
      "from:role_assignments": [okResponse([])],
      "rpc:approve_requisition": [okResponse(true), refused("sod_approval_requester")],
      "rpc:reject_requisition": [okResponse("t1"), denied()],
      "rpc:transition_requisition": [
        okResponse("t2"),
        refused("requisition_transition_not_allowed"),
      ],
    });
    const list = await listPeopleRequisitions(db, {
      orgId: "o1",
      projectId: "pr1",
      states: ["Proposed"],
    });
    expect(list.ok && list.data[0]?.estimatedMinor).toBe(76800);
    expect((await listPeopleRequisitions(db, { orgId: "o1" })).ok).toBe(false);
    expect((await getRequisition(db, "r1")).ok).toBe(true);
    expect((await getRequisition(db, "x")).ok).toBe(false);
    expect((await createRequisition(db, { orgId: "o1", projectId: "pr1", ...input })).ok).toBe(
      true,
    );
    expect((await createRequisition(db, { orgId: "o1", projectId: "pr1", ...input })).ok).toBe(
      false,
    );
    expect((await updateRequisition(db, "r1", input)).ok).toBe(true);
    expect((await updateRequisition(db, "r1", input)).ok).toBe(false);
    expect(await approveRequisition(db, "r1", "Ok.")).toEqual({
      ok: true,
      data: { complete: true },
    });
    expect((await approveRequisition(db, "r1", "Ok.")).ok).toBe(false);
    expect((await rejectRequisition(db, "r1", "No.")).ok).toBe(true);
    expect((await rejectRequisition(db, "r1", "No.")).ok).toBe(false);
    expect((await transitionRequisition(db, "r1", "Approved", "Filled", "Hired.")).ok).toBe(true);
    expect((await transitionRequisition(db, "r1", "Filled", "Proposed", "No.")).ok).toBe(false);
  });
});

describe("agreements", () => {
  const row = {
    id: "g1",
    project_id: null,
    offer_id: null,
    person_id: "p1",
    counterparty_id: null,
    agreement_kind: "Contractor Agreement",
    title: "Crew Services",
    agreement_state: "Sent",
    token_expires_at: "x",
    signed_at: null,
    signed_name: null,
    created_at: "x",
    person: { full_name: "Ann" },
    body: "Text.",
    signed_body_sha256: null,
  };
  it("lists, reads, writes, sends, moves and signs", async () => {
    const { db, calls } = client({
      "from:agreements": [
        okResponse([row]),
        denied(),
        okResponse(row),
        okResponse(null),
        okResponse({ id: "g1" }),
        denied(),
        okResponse([{ id: "g1" }]),
        refused("agreement_locked"),
      ],
      "from:agreement_state_transitions": [okResponse(ledger)],
      "rpc:send_agreement": [
        okResponse({ signing_token: "xagr_t", access_code: "12345678" }),
        denied(),
      ],
      "rpc:transition_agreement": [okResponse("t1"), refused("agreement_transition_not_allowed")],
      "rpc:sign_agreement": [okResponse(true), denied()],
    });
    const list = await listAgreements(db, { orgId: "o1", states: ["Sent"] });
    expect(list.ok && list.data[0]?.personName).toBe("Ann");
    expect((await listAgreements(db, { orgId: "o1" })).ok).toBe(false);
    const detail = await getAgreement(db, "g1");
    expect(detail.ok && detail.data.body).toBe("Text.");
    expect((await getAgreement(db, "x")).ok).toBe(false);
    const input = {
      orgId: "o1",
      projectId: null,
      personId: "p1",
      counterpartyId: null,
      offerId: null,
      kind: "Offer Letter" as const,
      title: " T ",
      body: " B ",
    };
    expect((await createAgreement(db, input)).ok).toBe(true);
    expect((await createAgreement(db, input)).ok).toBe(false);
    expect((await updateAgreement(db, "g1", { title: "T", body: "B" })).ok).toBe(true);
    expect((await updateAgreement(db, "g1", { title: "T", body: "B" })).ok).toBe(false);
    expect(await sendAgreement(db, "g1", "Go.", 7)).toEqual({
      ok: true,
      data: { signingToken: "xagr_t", accessCode: "12345678" },
    });
    expect((await sendAgreement(db, "g1", "Go.")).ok).toBe(false);
    expect((await transitionAgreement(db, "g1", "Signed", "Superseded", "Newer.")).ok).toBe(true);
    expect((await transitionAgreement(db, "g1", "Signed", "Canceled", "No.")).ok).toBe(false);
    expect(await signAgreement(db, "g1", " Ann ", "Text.")).toEqual({
      ok: true,
      data: { signed: true },
    });
    const signCall = calls.find((c) => c.target === "rpc:sign_agreement");
    expect(signCall?.steps[0]?.[1]).toEqual([
      { p_agreement_id: "g1", p_signed_name: "Ann", p_body_sha256: await bodyHash("Text.") },
    ]);
    expect((await signAgreement(db, "g1", "Ann", "Text.")).ok).toBe(false);
    expect(await bodyHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("offers and certifications", () => {
  it("lists offers with their latest terms", async () => {
    const { db } = client({
      "from:offers": [
        okResponse([
          {
            id: "o1",
            application_id: "ap1",
            offer_state: "Countered",
            created_at: "x",
            application: {
              opportunity_id: "op1",
              applicant: { full_name: "Ivy" },
              opportunity: { title: "Riggers" },
            },
            versions: [
              {
                version_number: 1,
                amount_minor: 30000,
                currency_code: "USD",
                rate_type: "Day",
                starts_on: "a",
                ends_on: "b",
                expires_at: null,
              },
              {
                version_number: 2,
                amount_minor: 32000,
                currency_code: "USD",
                rate_type: "Day",
                starts_on: "a",
                ends_on: "b",
                expires_at: null,
              },
            ],
          },
          {
            id: "o2",
            application_id: "ap2",
            offer_state: "Sent",
            created_at: "x",
            application: null,
            versions: null,
          },
        ]),
        denied(),
      ],
    });
    const offers = await listOffers(db, { orgId: "org", states: ["Countered", "Sent"] });
    expect(offers.ok && offers.data[0]?.latest?.amountMinor).toBe(32000);
    expect(offers.ok && offers.data[1]?.latest).toBeNull();
    expect((await listOffers(db, { orgId: "org" })).ok).toBe(false);
  });

  it("reads and writes certifications and holders", async () => {
    const holder = {
      id: "h1",
      certification_id: "c1",
      person_id: "p2",
      verified_by: "p1",
      issued_on: "2026-01-01",
      expires_on: null,
      public_verification_consented: false,
      certification: { name: "Rigger", issuing_body: "ETCP" },
      person: { full_name: "Zed" },
    };
    const { db } = client({
      "from:certifications": [
        okResponse([{ id: "c1", name: "Rigger", issuing_body: "ETCP" }]),
        denied(),
        okResponse({ id: "c1" }),
        denied(),
      ],
      "from:certification_holders": [
        okResponse([holder, { ...holder, id: "h2", expires_on: "2026-06-01" }]),
        denied(),
        okResponse(holder),
        okResponse(null),
        okResponse({ id: "h3" }),
        refused("credential_self_issue"),
        okResponse([{ id: "h1" }]),
        denied(),
      ],
    });
    expect((await listCertifications(db, "o1")).ok).toBe(true);
    expect((await listCertifications(db, "o1")).ok).toBe(false);
    expect(
      (await createCertification(db, "o1", { name: " Rigger ", issuingBody: " ETCP " })).ok,
    ).toBe(true);
    expect((await createCertification(db, "o1", { name: "R", issuingBody: "E" })).ok).toBe(false);
    const holders = await listCertificationHolders(db, { orgId: "o1", personId: "p2" });
    expect(holders.ok && holders.data.map((h) => h.id)).toEqual(["h2", "h1"]);
    expect((await listCertificationHolders(db, { orgId: "o1" })).ok).toBe(false);
    expect((await getCertificationHolder(db, "h1")).ok).toBe(true);
    expect((await getCertificationHolder(db, "x")).ok).toBe(false);
    const input = {
      orgId: "o1",
      certificationId: "c1",
      personId: "p2",
      issuedOn: "2026-01-01",
      expiresOn: null,
    };
    expect((await recordCertificationHolder(db, input)).ok).toBe(true);
    expect(await recordCertificationHolder(db, input)).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "credential_self_issue", message: "Refused." },
    });
    expect((await removeCertificationHolder(db, "h1", new Date("2027-01-01"))).ok).toBe(true);
    expect((await removeCertificationHolder(db, "h1")).ok).toBe(false);
    expect(certificateStatus(null, "2026-10-15")).toBe("current");
    expect(certificateStatus("2026-10-01", "2026-10-15")).toBe("expired");
    expect(certificateStatus("2026-11-01", "2026-10-15")).toBe("expiring");
    expect(certificateStatus("2027-06-01", "2026-10-15")).toBe("current");
  });
});
