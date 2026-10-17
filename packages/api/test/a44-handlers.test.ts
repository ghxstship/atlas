/**
 * Contract tests for A44's operations (Section 18, gate 5): the additional insureds a certificate
 * names and those an org requires (migration 1130, finding A38-001). Requests run through
 * `contractApp` against the in-memory client and every success is checked against
 * openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers as vendors } from "../src/handlers/vendors.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, requests, success, tenantRow } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(44000 + n).padStart(12, "0")}`;
const COI = id(1);
const NAMED = id(2);
const REQUIRED = id(3);
const PROJECT = id(4);
const MISSING = id(99);

function world() {
  const db = memoryDb(
    {
      insurance_certificate_insureds: [
        tenantRow(NAMED, ORG, {
          certificate_id: COI,
          insured_name: "Example Venue Owner LLC",
          endorsement_kind: "Additional Insured",
        }),
      ],
      required_additional_insureds: [
        tenantRow(REQUIRED, ORG, {
          project_id: null,
          insured_name: "Example Venue Owner LLC",
          endorsement_kind: "Additional Insured",
        }),
      ],
    },
    {},
    {
      insurance_certificate_insureds: { endorsement_kind: "Additional Insured" },
      required_additional_insureds: { endorsement_kind: "Additional Insured", project_id: null },
    },
  );
  return { db, http: requests(contractApp({ handlers: [vendors], db })) };
}

describe("Vendors contract: additional insureds", () => {
  it("serves insuranceCertificateInsureds", async () => {
    const { http } = world();
    await expectContract(
      await success(http.get("/insurance-certificate-insureds")),
      "insuranceCertificateInsureds.list",
    );
    await expectContract(
      await success(http.get(`/insurance-certificate-insureds/${NAMED}`)),
      "insuranceCertificateInsureds.get",
    );
    expect((await http.get(`/insurance-certificate-insureds/${MISSING}`)).status).toBe(404);
    const write1 = await success(
      http.post("/insurance-certificate-insureds", {
        certificate_id: COI,
        insured_name: "Example Promoter Inc",
        endorsement_kind: "Waiver of Subrogation",
      }),
    );
    await expectContract(write1, "insuranceCertificateInsureds.create");
    const write2 = await success(
      http.patch(`/insurance-certificate-insureds/${NAMED}`, {
        endorsement_kind: "Primary and Noncontributory",
      }),
    );
    await expectContract(write2, "insuranceCertificateInsureds.update");
    await expectContract(
      await success(http.delete(`/insurance-certificate-insureds/${NAMED}`)),
      "insuranceCertificateInsureds.delete",
    );
    expect((await http.get(`/insurance-certificate-insureds/${NAMED}`)).status).toBe(404);
  });

  it("serves requiredAdditionalInsureds", async () => {
    const { http } = world();
    await expectContract(
      await success(http.get("/required-additional-insureds")),
      "requiredAdditionalInsureds.list",
    );
    await expectContract(
      await success(http.get(`/required-additional-insureds/${REQUIRED}`)),
      "requiredAdditionalInsureds.get",
    );
    const write3 = await success(
      http.post("/required-additional-insureds", {
        project_id: PROJECT,
        insured_name: "Example Venue Owner LLC",
        endorsement_kind: "Additional Insured",
      }),
    );
    await expectContract(write3, "requiredAdditionalInsureds.create");
    const write4 = await success(
      http.patch(`/required-additional-insureds/${REQUIRED}`, {
        insured_name: "Example Venue Holdings LLC",
      }),
    );
    await expectContract(write4, "requiredAdditionalInsureds.update");
    await expectContract(
      await success(http.delete(`/required-additional-insureds/${REQUIRED}`)),
      "requiredAdditionalInsureds.delete",
    );
  });
});
