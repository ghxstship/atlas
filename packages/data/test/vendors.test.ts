import { describe, expect, it } from "vitest";
import {
  addVendorBankAccount,
  certificateStanding,
  createInsuranceCertificate,
  createScorecard,
  createSponsorEntitlement,
  createVendor,
  createVendorClass,
  decidePrequalification,
  deleteInsuranceCertificate,
  deleteScorecard,
  deleteSponsorEntitlement,
  deleteVendorClass,
  getVendor,
  listCounterparties,
  listCounterpartiesWithoutVendor,
  listInsuranceCertificates,
  listPrequalifications,
  listScorecards,
  listSponsorEntitlements,
  listStandardVendorClasses,
  listTransitionRules,
  listVendorBankAccounts,
  listVendorClasses,
  listVendors,
  requestPrequalification,
  scorecardAverage,
  setEntitlementFulfilled,
  setVendorClasses,
  transitionVendor,
  updateInsuranceCertificate,
  updateScorecard,
  updateSponsorEntitlement,
  updateVendor,
  updateVendorClass,
} from "../src/vendors.ts";
import { nextStates } from "../src/commercial-common.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

const vendorRow = (id: string, name: string | null, classes: string[] = []) => ({
  id,
  counterparty_id: `cp-${id}`,
  vendor_state: "Prospect",
  payment_terms_days: 30,
  default_currency_code: "USD",
  created_at: "2026-10-01T00:00:00Z",
  created_by: "p1",
  counterparty: { counterparty_name: name, counterparty_type: "Audio Supply" },
  vendor_class_assignments: [
    ...classes.map((c) => ({ vendor_class_id: c, deleted_at: null })),
    { vendor_class_id: "gone", deleted_at: "2026-10-02T00:00:00Z" },
  ],
});

const named = (name: string | null) => ({ vendor: { counterparty: { counterparty_name: name } } });

describe("vendors", () => {
  it("lists vendors by name with live class assignments", async () => {
    const { db, calls } = commercialClient({
      "from:vendors": [
        okResponse([vendorRow("v2", "Zephyr Audio", ["c1"]), vendorRow("v1", "Atlas Rigging")]),
      ],
    });
    const result = await listVendors(db, "o1");
    expect(result.ok && result.data.map((v) => v.name)).toEqual(["Atlas Rigging", "Zephyr Audio"]);
    expect(result.ok && result.data[1]?.classIds).toEqual(["c1"]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "o1"]]);
  });

  it("returns read errors and missing vendors as typed errors", async () => {
    const { db } = commercialClient({
      "from:vendors": [
        errorResponse("08006", "down"),
        okResponse(null),
        okResponse(vendorRow("v1", null)),
      ],
    });
    expect((await listVendors(db, "o1")).ok).toBe(false);
    expect(await getVendor(db, "v9")).toEqual({ ok: false, error: { kind: "not-found" } });
    const found = await getVendor(db, "v1");
    expect(found.ok && found.data.name).toBeNull();
  });

  it("creates a new company as a counterparty, then the vendor facet", async () => {
    const { db, calls } = commercialClient({
      "rpc:create_counterparty": [okResponse("cp9")],
      "from:vendors": [okResponse({ id: "v9" })],
    });
    const result = await createVendor(db, {
      orgId: "o1",
      name: " Harbor Audio ",
      counterpartyType: "",
      paymentTermsDays: 15,
      defaultCurrencyCode: " ",
    });
    expect(result).toEqual({ ok: true, data: { id: "v9" } });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_name: "Harbor Audio", p_counterparty_type: null }],
    ]);
    expect(calls[1]?.steps[0]).toEqual([
      "insert",
      [{ counterparty_id: "cp9", payment_terms_days: 15, default_currency_code: null }],
    ]);
  });

  it("links an existing counterparty and surfaces refusals", async () => {
    const { db, calls } = commercialClient({
      "from:vendors": [okResponse({ id: "v1" })],
      "rpc:create_counterparty": [
        errorResponse("XR001", "counterparty_name_required: Name.", "counterparty_name_required"),
      ],
    });
    expect((await createVendor(db, { orgId: "o1", counterpartyId: "cp1" })).ok).toBe(true);
    expect(calls[0]?.target).toBe("from:vendors");
    expect(await createVendor(db, { orgId: "o1", name: "" })).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "counterparty_name_required", message: "Name." },
    });
  });

  it("updates terms and treats a filtered update as not found", async () => {
    const { db } = commercialClient({
      "from:vendors": [okResponse([{ id: "v1" }]), okResponse([])],
    });
    expect(
      await updateVendor(db, "v1", { paymentTermsDays: 45, defaultCurrencyCode: "EUR" }),
    ).toEqual({ ok: true, data: null });
    expect(
      await updateVendor(db, "v2", { paymentTermsDays: null, defaultCurrencyCode: null }),
    ).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("transitions with compare-and-set and maps refusals", async () => {
    const { db, calls } = commercialClient({
      "rpc:transition_vendor": [
        okResponse("t1"),
        errorResponse("XR001", "illegal_transition: No.", "illegal_transition"),
      ],
    });
    const move = {
      id: "v1",
      expected: "Prospect",
      next: "Onboarded",
      reason: "Paperwork in.",
    } as const;
    expect(await transitionVendor(db, move)).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_vendor_id: "v1",
          p_expected: "Prospect",
          p_next: "Onboarded",
          p_reason: "Paperwork in.",
        },
      ],
    ]);
    expect((await transitionVendor(db, move)).ok).toBe(false);
  });

  it("reads lifecycle rules and offers only allowed moves", async () => {
    const { db } = commercialClient({
      "from:lifecycle_transition_rules": [
        okResponse([
          { from_state: "Prospect", to_state: "Onboarded" },
          { from_state: "Prospect", to_state: "Canceled" },
          { from_state: "Active", to_state: "Blocked" },
        ]),
      ],
    });
    const rules = await listTransitionRules(db, "vendor");
    expect(rules.ok && nextStates(rules.data, "Prospect")).toEqual(["Onboarded", "Canceled"]);
  });

  it("lists counterparties with and without a vendor facet", async () => {
    const { db } = commercialClient({
      "from:counterparties": [
        okResponse([
          {
            id: "c2",
            counterparty_name: "Beta",
            counterparty_type: null,
            vendors: [{ id: "v", deleted_at: null }],
          },
          {
            id: "c1",
            counterparty_name: "Alpha",
            counterparty_type: "Sponsor",
            vendors: [{ id: "v0", deleted_at: "x" }],
          },
        ]),
        okResponse([
          { id: "c2", counterparty_name: "Beta", counterparty_type: null },
          { id: "c1", counterparty_name: null, counterparty_type: null },
        ]),
        errorResponse("42501", "no"),
      ],
    });
    const free = await listCounterpartiesWithoutVendor(db, "o1");
    expect(free.ok && free.data).toEqual([
      { id: "c1", name: "Alpha", counterpartyType: "Sponsor" },
    ]);
    const all = await listCounterparties(db, "o1");
    expect(all.ok && all.data.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect((await listCounterpartiesWithoutVendor(db, "o1")).ok).toBe(false);
  });
});

describe("vendor classes", () => {
  it("lists classes with live vendor counts", async () => {
    const { db } = commercialClient({
      "from:vendor_classes": [
        okResponse([
          {
            id: "k2",
            name: "Staging",
            description: null,
            std_vendor_class_id: null,
            vendor_class_assignments: [
              { id: "a", deleted_at: null },
              { id: "b", deleted_at: "x" },
            ],
          },
          {
            id: "k1",
            name: "Audio",
            description: "Sound.",
            std_vendor_class_id: "VC-1",
            vendor_class_assignments: null,
          },
        ]),
        errorResponse("08006", "down"),
      ],
    });
    const result = await listVendorClasses(db, "o1");
    expect(result.ok && result.data.map((c) => [c.name, c.vendorCount])).toEqual([
      ["Audio", 0],
      ["Staging", 1],
    ]);
    expect((await listVendorClasses(db, "o1")).ok).toBe(false);
  });

  it("creates, edits and soft deletes classes", async () => {
    const { db, calls } = commercialClient({
      "from:vendor_classes": [
        okResponse({ id: "k1" }),
        okResponse([{ id: "k1" }]),
        okResponse([{ id: "k1" }]),
      ],
    });
    const input = { name: " Audio ", description: " ", stdVendorClassId: "VC-1" };
    expect(await createVendorClass(db, "o1", input)).toEqual({ ok: true, data: { id: "k1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ org_id: "o1", name: "Audio", description: null, std_vendor_class_id: "VC-1" }],
    ]);
    expect((await updateVendorClass(db, "k1", input)).ok).toBe(true);
    expect((await deleteVendorClass(db, "k1")).ok).toBe(true);
    expect(calls[2]?.steps[0]?.[0]).toBe("update");
  });

  it("sets exactly the chosen classes on a vendor", async () => {
    const { db, calls } = commercialClient({
      "from:vendor_class_assignments": [
        okResponse([
          { id: "a1", vendor_class_id: "k1" },
          { id: "a2", vendor_class_id: "k2" },
        ]),
        okResponse([{ id: "a3" }]),
        okResponse([{ id: "a2" }]),
      ],
    });
    expect(await setVendorClasses(db, "v1", ["k1", "k3"])).toEqual({ ok: true, data: null });
    expect(calls[1]?.steps[0]).toEqual(["insert", [[{ vendor_id: "v1", vendor_class_id: "k3" }]]]);
    expect(calls[2]?.steps).toContainEqual(["in", ["id", ["a2"]]]);
  });

  it("stops at the first failing step when setting classes", async () => {
    const read = commercialClient({
      "from:vendor_class_assignments": [errorResponse("08006", "down")],
    });
    expect((await setVendorClasses(read.db, "v1", [])).ok).toBe(false);
    const add = commercialClient({
      "from:vendor_class_assignments": [okResponse([]), errorResponse("23505", "dup")],
    });
    expect(await setVendorClasses(add.db, "v1", ["k1"])).toEqual({
      ok: false,
      error: { kind: "conflict", message: "dup" },
    });
    const end = commercialClient({
      "from:vendor_class_assignments": [
        okResponse([{ id: "a1", vendor_class_id: "k1" }]),
        errorResponse("42501", "no"),
      ],
    });
    expect((await setVendorClasses(end.db, "v1", [])).ok).toBe(false);
    const none = commercialClient({
      "from:vendor_class_assignments": [okResponse([{ id: "a1", vendor_class_id: "k1" }])],
    });
    expect((await setVendorClasses(none.db, "v1", ["k1"])).ok).toBe(true);
  });

  it("reads Standard Library classes from canon", async () => {
    const { db, calls } = commercialClient({
      "from:xpms:std_vendor_class": [
        okResponse([{ record_id: "VC-1", class: null, description: "A." }]),
      ],
    });
    const result = await listStandardVendorClasses(db);
    expect(result.ok && result.data).toEqual([{ id: "VC-1", name: "VC-1", description: "A." }]);
    expect(calls[0]?.target).toBe("from:xpms:std_vendor_class");
  });
});

describe("prequalifications", () => {
  it("lists prequalifications for the org or one vendor", async () => {
    const row = {
      id: "q1",
      vendor_id: "v1",
      scope_note: "Rigging.",
      decision: null,
      decided_at: null,
      decided_by: null,
      valid_to: null,
      created_at: "t",
      created_by: "p1",
      ...named("Atlas"),
    };
    const { db, calls } = commercialClient({
      "from:prequalifications": [okResponse([row]), okResponse([])],
    });
    const result = await listPrequalifications(db, "o1");
    expect(result.ok && result.data[0]?.vendorName).toBe("Atlas");
    await listPrequalifications(db, "o1", "v1");
    expect(calls[1]?.steps).toContainEqual(["eq", ["vendor_id", "v1"]]);
  });

  it("requests and decides", async () => {
    const { db, calls } = commercialClient({
      "from:prequalifications": [okResponse({ id: "q1" })],
      "rpc:decide_prequalification": [
        okResponse(null),
        errorResponse("XR001", "sod_approval_requester: No.", "sod_approval_requester"),
      ],
    });
    expect(
      (await requestPrequalification(db, { vendorId: "v1", scopeNote: " Rigging. " })).ok,
    ).toBe(true);
    expect(calls[0]?.steps[0]).toEqual(["insert", [{ vendor_id: "v1", scope_note: "Rigging." }]]);
    expect(
      (await decidePrequalification(db, { id: "q1", decision: "Approved", validTo: "2027-01-01" }))
        .ok,
    ).toBe(true);
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_prequalification_id: "q1", p_decision: "Approved", p_valid_to: "2027-01-01" }],
    ]);
    const refused = await decidePrequalification(db, {
      id: "q1",
      decision: "Rejected",
      validTo: null,
    });
    expect(refused.ok === false && refused.error.kind).toBe("refusal");
    expect(calls[2]?.steps[0]).toEqual([
      "args",
      [{ p_prequalification_id: "q1", p_decision: "Rejected" }],
    ]);
  });
});

describe("insurance certificates", () => {
  it("derives standing from the validity window", () => {
    const today = "2026-10-14";
    expect(certificateStanding({ validFrom: "2026-01-01", validTo: "2026-10-13" }, today)).toBe(
      "expired",
    );
    expect(certificateStanding({ validFrom: "2026-11-01", validTo: "2027-10-13" }, today)).toBe(
      "future",
    );
    expect(certificateStanding({ validFrom: "2026-01-01", validTo: "2026-11-01" }, today)).toBe(
      "expiring",
    );
    expect(certificateStanding({ validFrom: "2026-01-01", validTo: "2027-06-01" }, today)).toBe(
      "current",
    );
  });

  it("lists, records, edits and removes certificates", async () => {
    const row = {
      id: "i1",
      vendor_id: "v1",
      insurer: "Gulf Mutual",
      policy_identifier: "GL-1",
      coverage_type: "General Liability",
      coverage_limit_minor: null,
      currency_code: null,
      valid_from: "2026-01-01",
      valid_to: "2027-01-01",
      document_uri: null,
      ...named("Atlas"),
    };
    const { db, calls } = commercialClient({
      "from:insurance_certificates": [
        okResponse([row]),
        okResponse([]),
        okResponse({ id: "i1" }),
        okResponse([{ id: "i1" }]),
        okResponse([{ id: "i1" }]),
      ],
    });
    const list = await listInsuranceCertificates(db, "o1");
    expect(list.ok && list.data[0]?.coverageLimitMinor).toBeNull();
    await listInsuranceCertificates(db, "o1", "v1");
    expect(calls[1]?.steps).toContainEqual(["eq", ["vendor_id", "v1"]]);
    const input = {
      vendorId: "v1",
      insurer: " Gulf ",
      policyIdentifier: "GL-1",
      coverageType: "GL",
      coverageLimitMinor: 100000000,
      currencyCode: "USD",
      validFrom: "2026-01-01",
      validTo: "2027-01-01",
      documentUri: "",
    };
    expect((await createInsuranceCertificate(db, input)).ok).toBe(true);
    expect(calls[2]?.steps[0]?.[1]).toEqual([
      {
        vendor_id: "v1",
        insurer: "Gulf",
        policy_identifier: "GL-1",
        coverage_type: "GL",
        coverage_limit_minor: 100000000,
        currency_code: "USD",
        valid_from: "2026-01-01",
        valid_to: "2027-01-01",
        document_uri: null,
      },
    ]);
    expect((await updateInsuranceCertificate(db, "i1", input)).ok).toBe(true);
    expect((await deleteInsuranceCertificate(db, "i1")).ok).toBe(true);
  });
});

describe("scorecards", () => {
  it("averages only scored dimensions and never invents zero", () => {
    expect(scorecardAverage({ qualityScore: 5, deliveryScore: 4, safetyScore: null })).toBe(4.5);
    expect(
      scorecardAverage({ qualityScore: null, deliveryScore: null, safetyScore: null }),
    ).toBeNull();
    expect(scorecardAverage({ qualityScore: 4, deliveryScore: 4, safetyScore: 5 })).toBe(4.3);
  });

  it("lists, creates, edits and removes scorecards", async () => {
    const row = {
      id: "s1",
      vendor_id: "v1",
      project_id: null,
      period_end: "2026-09-30",
      quality_score: 4,
      delivery_score: null,
      safety_score: 5,
      note: null,
      ...named("Atlas"),
    };
    const { db, calls } = commercialClient({
      "from:vendor_scorecards": [
        okResponse([row]),
        okResponse([]),
        okResponse({ id: "s1" }),
        okResponse([{ id: "s1" }]),
        okResponse([{ id: "s1" }]),
      ],
    });
    expect((await listScorecards(db, "o1")).ok).toBe(true);
    await listScorecards(db, "o1", "v1");
    expect(calls[1]?.steps).toContainEqual(["eq", ["vendor_id", "v1"]]);
    const input = {
      vendorId: "v1",
      projectId: "",
      periodEnd: "2026-09-30",
      qualityScore: 4,
      deliveryScore: null,
      safetyScore: 5,
      note: " ",
    };
    expect((await createScorecard(db, input)).ok).toBe(true);
    expect(calls[2]?.steps[0]?.[1]).toEqual([
      {
        vendor_id: "v1",
        project_id: null,
        period_end: "2026-09-30",
        quality_score: 4,
        delivery_score: null,
        safety_score: 5,
        note: null,
      },
    ]);
    expect((await updateScorecard(db, "s1", input)).ok).toBe(true);
    expect((await deleteScorecard(db, "s1")).ok).toBe(true);
  });
});

describe("sponsor entitlements", () => {
  it("lists entitlements with project and sponsor names", async () => {
    const { db } = commercialClient({
      "from:sponsor_entitlements": [
        okResponse([
          {
            id: "e1",
            project_id: "p1",
            counterparty_id: "c1",
            description: "Naming rights.",
            quantity: null,
            due_on: null,
            fulfilled_at: null,
            project: { name: "Summer", project_key: "NWL" },
            counterparty: { counterparty_name: "Brewery" },
          },
          {
            id: "e2",
            project_id: "p1",
            counterparty_id: "c1",
            description: "Banner.",
            quantity: 2,
            due_on: "2026-11-01",
            fulfilled_at: "t",
            project: null,
            counterparty: null,
          },
        ]),
      ],
    });
    const result = await listSponsorEntitlements(db, "o1");
    expect(result.ok && result.data.map((e) => [e.projectKey, e.sponsorName])).toEqual([
      ["NWL", "Brewery"],
      [null, null],
    ]);
  });

  it("creates, edits, fulfills and removes entitlements", async () => {
    const now = new Date("2026-10-14T10:00:00Z");
    const { db, calls } = commercialClient({
      "from:sponsor_entitlements": [
        okResponse({ id: "e1" }),
        okResponse([{ id: "e1" }]),
        okResponse([{ id: "e1" }]),
        okResponse([{ id: "e1" }]),
        okResponse([{ id: "e1" }]),
      ],
    });
    expect(
      (
        await createSponsorEntitlement(db, {
          projectId: "p1",
          counterpartyId: "c1",
          description: " Banner. ",
          quantity: 2,
          dueOn: "",
        })
      ).ok,
    ).toBe(true);
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        project_id: "p1",
        counterparty_id: "c1",
        description: "Banner.",
        quantity: 2,
        due_on: null,
      },
    ]);
    expect(
      (
        await updateSponsorEntitlement(db, "e1", {
          counterpartyId: "c1",
          description: "B.",
          quantity: null,
          dueOn: "2026-11-01",
        })
      ).ok,
    ).toBe(true);
    await setEntitlementFulfilled(db, "e1", true, now);
    expect(calls[2]?.steps[0]).toEqual(["update", [{ fulfilled_at: "2026-10-14T10:00:00.000Z" }]]);
    await setEntitlementFulfilled(db, "e1", false);
    expect(calls[3]?.steps[0]).toEqual(["update", [{ fulfilled_at: null }]]);
    expect((await deleteSponsorEntitlement(db, "e1")).ok).toBe(true);
  });
});

describe("bank accounts", () => {
  it("reads masked accounts and keeps Restricted numbers null when masked", async () => {
    const { db, calls } = commercialClient({
      "from:vendor_bank_accounts_masked": [
        okResponse([
          {
            id: "b1",
            bank_name: "Gulf Bank",
            account_holder: "Atlas",
            account_last4: "6789",
            account_number: null,
            routing_number: null,
            is_masked: true,
          },
          {
            id: null,
            bank_name: null,
            account_holder: null,
            account_last4: null,
            account_number: null,
            routing_number: null,
            is_masked: null,
          },
        ]),
      ],
    });
    const result = await listVendorBankAccounts(db, "v1");
    expect(result.ok && result.data[0]).toEqual({
      id: "b1",
      bankName: "Gulf Bank",
      accountHolder: "Atlas",
      accountLast4: "6789",
      accountNumber: null,
      routingNumber: null,
      isMasked: true,
    });
    expect(result.ok && result.data[1]?.isMasked).toBe(true);
    expect(calls[0]?.target).toBe("from:vendor_bank_accounts_masked");
  });

  it("adds through the encrypting RPC and refuses numbers the database would", async () => {
    const { db, calls } = commercialClient({
      "rpc:set_vendor_bank_account": [
        okResponse("b1"),
        okResponse("b2"),
        errorResponse("XR001", "bank_account_details: No.", "bank_account_details"),
      ],
    });
    const input = {
      vendorId: "v1",
      bankName: " Gulf ",
      accountHolder: "Atlas",
      accountNumber: "0001-2345-6789",
      routingNumber: "",
    };
    expect(await addVendorBankAccount(db, input)).toEqual({ ok: true, data: { id: "b1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_vendor_id: "v1",
          p_bank_name: "Gulf",
          p_account_holder: "Atlas",
          p_account_number: "0001-2345-6789",
        },
      ],
    ]);
    expect(await addVendorBankAccount(db, { ...input, routingNumber: " 063100277 " })).toEqual({
      ok: true,
      data: { id: "b2" },
    });
    expect((calls[1]?.steps[0]?.[1] as Record<string, unknown>[])[0]).toMatchObject({
      p_routing_number: "063100277",
    });
    expect((await addVendorBankAccount(db, input)).ok).toBe(false);
    expect(await addVendorBankAccount(db, { ...input, accountNumber: "12-" })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "account_number" },
    });
    expect(await addVendorBankAccount(db, { ...input, accountNumber: "1".repeat(35) })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "account_number" },
    });
    expect(await addVendorBankAccount(db, { ...input, routingNumber: "9".repeat(35) })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "routing_number" },
    });
    expect(calls).toHaveLength(3);
  });
});
