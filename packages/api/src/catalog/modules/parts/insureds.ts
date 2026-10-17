/**
 * Additional insureds (migration 1130, finding A38-001, journey 43): the parties a certificate of
 * insurance names and the parties an org requires its vendors to name. Aurora's certificate
 * extraction proposes each named party as an insuranceCertificateInsureds.create line, confirmed
 * with the certificate it belongs to. catalog/modules/vendors.ts spreads them into the Vendors
 * additions.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { editDefinition, orNull } from "../../correct.ts";
import { resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const endorsement = z
  .enum(["Additional Insured", "Primary and Noncontributory", "Waiver of Subrogation"])
  .meta({
    description:
      "Endorsement: Additional Insured, Primary and Noncontributory, or Waiver of Subrogation.",
    example: "Additional Insured",
  });

const InsuranceCertificateInsured = editDefinition(
  defineResource({
    name: "InsuranceCertificateInsured",
    table: "app.insurance_certificate_insureds",
    description:
      "A party a certificate of insurance names, with the endorsement it grants (1130). A name appears once per endorsement on a certificate, ignoring case and spacing (409).",
    fields: {
      certificate_id: fields.ref("certificate naming the party"),
      insured_name: fields.text("Party named, as printed.", "Example Venue Owner LLC", 200),
      endorsement_kind: endorsement,
    },
    immutable: ["certificate_id"],
  }),
  { nullable: ["created_by", "updated_by"] },
);

const RequiredAdditionalInsured = editDefinition(
  defineResource({
    name: "RequiredAdditionalInsured",
    table: "app.required_additional_insureds",
    description:
      "A party the org requires its vendors' certificates to name (1130): org-wide when project_id is null, or for vendors engaged on one project as well. app.verify_onboarding_insureds checks an engagement against them.",
    fields: {
      project_id: orNull(fields.ref("project the requirement adds to; null for every project")),
      insured_name: fields.text("Party that must be named.", "Example Venue Owner LLC", 200),
      endorsement_kind: endorsement,
    },
    immutable: ["project_id"],
  }),
  { nullable: ["created_by", "updated_by"] },
);

export const insuredResources: readonly ResourceSpec[] = [
  resource("Vendors", "/insurance-certificate-insureds", InsuranceCertificateInsured),
  resource("Vendors", "/required-additional-insureds", RequiredAdditionalInsured),
];

export const insuredCapabilities: Readonly<Record<string, CapabilityRule>> = {
  insuranceCertificateInsureds: { read: "vendors.vendor.read", write: "vendors.coi.write" },
  requiredAdditionalInsureds: { read: "vendors.vendor.read", write: "vendors.coi.write" },
};
