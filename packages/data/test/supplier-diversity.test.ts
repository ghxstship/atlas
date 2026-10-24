import { describe, expect, it } from "vitest";
import {
  addSupplierDiversity,
  listMySupplierDiversity,
  listSharedSupplierDiversity,
  listSupplierDiversityPrograms,
  removeSupplierDiversity,
  revokeSupplierDiversityShare,
  shareSupplierDiversity,
  SUPPLIER_DIVERSITY_KINDS,
} from "../src/supplier-diversity.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

describe("supplier diversity (A89, migration 1464)", () => {
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
          certificate_number: null,
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

  it("reads what was shared with an org, masked without the capability", async () => {
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
            certificate_number: null,
            certificate_number_masked: true,
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
      numberMasked: true,
    });
    expect((await listSharedSupplierDiversity(db, "o1")).ok).toBe(false);
  });

  it("knows every kind", () => {
    expect(SUPPLIER_DIVERSITY_KINDS).toContain("LGBTQ+-Owned");
  });
});
