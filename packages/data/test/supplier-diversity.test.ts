import { describe, expect, it } from "vitest";
import {
  addSupplierDiversity,
  listMySupplierDiversity,
  listSharedSupplierDiversity,
  listSupplierDiversityPrograms,
  removeSupplierDiversity,
  revealSharedSupplierDiversityNumber,
  revokeSupplierDiversityShare,
  shareSupplierDiversity,
  SUPPLIER_DIVERSITY_KINDS,
} from "../src/supplier-diversity.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

describe("supplier diversity (A89, migrations 1464 and 2011)", () => {
  it("lists the owner's certifications with their shares, the number reduced to four characters", async () => {
    const { db, calls } = fakeClient({
      "rpc:my_supplier_diversity": [
        okResponse([
          {
            id: "c1",
            diversity_kind: "Women-Owned",
            certifying_body: "Florida OSD",
            certificate_number_last4: "8842",
            issued_on: "2026-01-15",
            expires_on: null,
            evidence_path: null,
            shares: [
              { shareId: "s1", orgId: "o1", orgName: "Northwind Live", sharedAt: "2026-10-01" },
              "junk",
            ],
          },
        ]),
        errorResponse("42501", "no"),
      ],
    });
    const mine = await listMySupplierDiversity(db);
    expect(mine.ok && mine.data[0]).toEqual({
      id: "c1",
      kind: "Women-Owned",
      certifyingBody: "Florida OSD",
      numberLast4: "8842",
      issuedOn: "2026-01-15",
      expiresOn: null,
      shares: [{ shareId: "s1", orgId: "o1", orgName: "Northwind Live", sharedAt: "2026-10-01" }],
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{}]]);
    expect((await listMySupplierDiversity(db, "acct")).ok).toBe(false);
    expect(calls[1]?.steps[0]).toEqual(["args", [{ p_account_id: "acct" }]]);
  });

  it("declares one for the person or for the company, and removes it", async () => {
    const { db, calls } = fakeClient({
      "from:supplier_diversity_certifications": [
        okResponse({ id: "c1" }),
        okResponse({ id: "c2" }),
        errorResponse("42501", "no"),
        okResponse(null),
      ],
    });
    const input = {
      personId: "me",
      accountId: null,
      kind: "Veteran-Owned" as const,
      certifyingBody: " Self-declared ",
      certificateNumber: " ",
      issuedOn: null,
      expiresOn: null,
    };
    expect(await addSupplierDiversity(db, input)).toEqual({ ok: true, data: { id: "c1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [
        {
          person_id: "me",
          account_id: null,
          diversity_kind: "Veteran-Owned",
          certifying_body: "Self-declared",
          issued_on: null,
          expires_on: null,
        },
      ],
    ]);
    expect((await addSupplierDiversity(db, { ...input, accountId: "acct" })).ok).toBe(true);
    expect((calls[1]?.steps[0]?.[1] as Record<string, unknown>[])[0]).toMatchObject({
      person_id: null,
      account_id: "acct",
    });
    expect((await addSupplierDiversity(db, input)).ok).toBe(false);
    expect((await removeSupplierDiversity(db, "c1")).ok).toBe(true);
  });

  it("sets a certificate number through the encrypting RPC, never in the insert", async () => {
    const { db, calls } = fakeClient({
      "from:supplier_diversity_certifications": [
        okResponse({ id: "c1" }),
        okResponse({ id: "c2" }),
      ],
      "rpc:set_supplier_diversity_certificate_number": [
        okResponse(null),
        errorResponse("XR001", "certificate_number_format: No.", "certificate_number_format"),
      ],
    });
    const input = {
      personId: "me",
      accountId: null,
      kind: "Women-Owned" as const,
      certifyingBody: "Florida OSD",
      certificateNumber: " FL-WBE-2026-118842 ",
      issuedOn: null,
      expiresOn: null,
    };
    expect(await addSupplierDiversity(db, input)).toEqual({ ok: true, data: { id: "c1" } });
    expect((calls[0]?.steps[0]?.[1] as Record<string, unknown>[])[0]).not.toHaveProperty(
      "certificate_number",
    );
    expect(calls[1]?.target).toBe("rpc:set_supplier_diversity_certificate_number");
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_certification_id: "c1", p_certificate_number: "FL-WBE-2026-118842" }],
    ]);
    expect(await addSupplierDiversity(db, input)).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "certificate_number_format", message: "No." },
    });
    expect(await addSupplierDiversity(db, { ...input, certificateNumber: "--" })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "certificate_number" },
    });
    expect(calls).toHaveLength(4);
  });

  it("offers the orgs that run a program, shares and revokes", async () => {
    const { db } = fakeClient({
      "rpc:supplier_diversity_programs": [
        okResponse([{ org_id: "o1", org_name: "Northwind Live" }]),
        errorResponse("42501", "no"),
      ],
      "rpc:share_supplier_diversity": [
        okResponse("s1"),
        errorResponse("XR001", "x", "supplier_diversity_no_program"),
      ],
      "rpc:revoke_supplier_diversity_share": [okResponse(null)],
    });
    expect(await listSupplierDiversityPrograms(db)).toEqual({
      ok: true,
      data: [{ orgId: "o1", orgName: "Northwind Live" }],
    });
    expect((await listSupplierDiversityPrograms(db, "acct")).ok).toBe(false);
    expect(await shareSupplierDiversity(db, { certificationId: "c1", orgId: "o1" })).toEqual({
      ok: true,
      data: { shareId: "s1" },
    });
    expect((await shareSupplierDiversity(db, { certificationId: "c1", orgId: "o2" })).ok).toBe(
      false,
    );
    expect((await revokeSupplierDiversityShare(db, "s1")).ok).toBe(true);
  });

  it("reads what was shared with an org, the number reduced to its last four", async () => {
    const { db } = fakeClient({
      "rpc:shared_supplier_diversity": [
        okResponse([
          {
            share_id: "s1",
            certification_id: "c1",
            person_id: "p1",
            person_name: "Ivy Marchetti",
            account_id: null,
            account_name: null,
            diversity_kind: "Women-Owned",
            certifying_body: "Florida OSD",
            certificate_number_last4: "8842",
            issued_on: null,
            expires_on: null,
            shared_at: "2026-10-01T00:00:00Z",
          },
        ]),
        errorResponse("42501", "no"),
      ],
    });
    const shared = await listSharedSupplierDiversity(db, "o1");
    expect(shared.ok && shared.data[0]).toMatchObject({
      ownerName: "Ivy Marchetti",
      ownerKind: "person",
      numberLast4: "8842",
    });
    expect((await listSharedSupplierDiversity(db, "o1")).ok).toBe(false);
  });

  it("reveals a shared number with a reason, and passes step-up refusals through", async () => {
    const { db, calls } = fakeClient({
      "rpc:reveal_shared_supplier_diversity_number": [
        okResponse("FLWBE2026118842"),
        errorResponse("XR001", "step_up_required: Confirm it is you.", "step_up_required"),
      ],
    });
    expect(await revealSharedSupplierDiversityNumber(db, "s1", "Annual program audit.")).toEqual({
      ok: true,
      data: "FLWBE2026118842",
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_share_id: "s1", p_reason: "Annual program audit." }],
    ]);
    expect(await revealSharedSupplierDiversityNumber(db, "s1", "Annual program audit.")).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "step_up_required", message: "Confirm it is you." },
    });
  });

  it("knows every kind", () => {
    expect(SUPPLIER_DIVERSITY_KINDS).toContain("LGBTQ+-Owned");
  });
});
