import { describe, expect, it } from "vitest";
import {
  addCertificateInsured,
  addRequiredInsured,
  listCertificateChecks,
  listCertificateInsureds,
  listEngagementInsuredChecks,
  listRequiredInsureds,
  removeCertificateInsured,
  removeRequiredInsured,
  verifyOnboardingInsureds,
} from "../src/insureds.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

describe("additional insureds", () => {
  it("lists insureds for certificates and reads nothing for none", async () => {
    const { db, calls } = commercialClient({
      "from:insurance_certificate_insureds": [
        okResponse([
          {
            id: "n1",
            certificate_id: "c1",
            insured_name: "Venue Owner LLC",
            endorsement_kind: "Additional Insured",
          },
        ]),
      ],
    });
    expect(await listCertificateInsureds(db, [])).toEqual({ ok: true, data: [] });
    const listed = await listCertificateInsureds(db, ["c1"]);
    expect(listed.ok && listed.data[0]).toEqual({
      id: "n1",
      certificateId: "c1",
      insuredName: "Venue Owner LLC",
      endorsementKind: "Additional Insured",
    });
    expect(calls[0]?.steps).toContainEqual(["in", ["certificate_id", ["c1"]]]);
  });

  it("adds and removes certificate insureds, trimming the name", async () => {
    const { db, calls } = commercialClient({
      "from:insurance_certificate_insureds": [okResponse({ id: "n2" }), okResponse([{ id: "n2" }])],
    });
    expect(
      await addCertificateInsured(db, {
        certificateId: "c1",
        insuredName: "  Venue Owner LLC ",
        endorsementKind: "Waiver of Subrogation",
      }),
    ).toEqual({ ok: true, data: { id: "n2" } });
    expect(calls[0]?.steps).toContainEqual([
      "insert",
      [
        {
          certificate_id: "c1",
          insured_name: "Venue Owner LLC",
          endorsement_kind: "Waiver of Subrogation",
        },
      ],
    ]);
    expect(await removeCertificateInsured(db, "n2")).toEqual({ ok: true, data: null });
  });

  it("lists, adds and removes required insureds with their project", async () => {
    const { db } = commercialClient({
      "from:required_additional_insureds": [
        okResponse([
          {
            id: "r1",
            project_id: "p1",
            insured_name: "Venue Owner LLC",
            endorsement_kind: "Additional Insured",
            project: { name: "Summer Series" },
          },
          {
            id: "r2",
            project_id: null,
            insured_name: "Demo Productions",
            endorsement_kind: "Additional Insured",
            project: null,
          },
        ]),
        okResponse({ id: "r3" }),
        okResponse([]),
      ],
    });
    const listed = await listRequiredInsureds(db, "o1");
    expect(listed.ok && listed.data.map((r) => r.projectName)).toEqual(["Summer Series", null]);
    expect(
      await addRequiredInsured(db, {
        orgId: "o1",
        projectId: null,
        insuredName: "Demo Productions",
        endorsementKind: "Additional Insured",
      }),
    ).toEqual({ ok: true, data: { id: "r3" } });
    expect(await removeRequiredInsured(db, "r9")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("reads engagement and certificate checks", async () => {
    const { db } = commercialClient({
      "from:engagement_insured_checks": [
        okResponse([
          {
            required_insured_id: "r1",
            insured_name: "Venue Owner LLC",
            endorsement_kind: "Additional Insured",
            project_specific: true,
            named_on_certificate_id: null,
          },
        ]),
      ],
      "from:insurance_certificate_checks": [
        okResponse([
          {
            certificate_id: "c1",
            insured_count: 2,
            required_count: 1,
            missing_count: 0,
            insureds_verified: true,
          },
        ]),
      ],
    });
    const checks = await listEngagementInsuredChecks(db, "e1");
    expect(checks.ok && checks.data[0]?.namedOnCertificateId).toBeNull();
    expect(checks.ok && checks.data[0]?.projectSpecific).toBe(true);
    const certs = await listCertificateChecks(db, "o1");
    expect(certs.ok && certs.data[0]?.insuredsVerified).toBe(true);
  });

  it("runs the verification step and returns refusals typed", async () => {
    const { db, calls } = commercialClient({
      "rpc:verify_onboarding_insureds": [
        okResponse({ outcome: "Failed", missing: ["Venue Owner LLC (Additional Insured)"] }),
        okResponse({}),
        errorResponse("XR001", "insureds_none_required: The org requires no additional insureds."),
      ],
    });
    expect(await verifyOnboardingInsureds(db, "i1")).toEqual({
      ok: true,
      data: { outcome: "Failed", missing: ["Venue Owner LLC (Additional Insured)"] },
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_item_id: "i1" }]]);
    expect((await verifyOnboardingInsureds(db, "i1")).ok).toBe(false);
    const refused = await verifyOnboardingInsureds(db, "i1");
    expect(!refused.ok && refused.error.kind).toBe("refusal");
  });
});
