import type { Database, XosClient } from "./client.ts";
import { deletedNow, insertedId, readRows, rpcValue, touched } from "./commercial-common.ts";
import { fail, ok, type Result } from "./result.ts";
import * as enums from "./enums.generated.ts";

/**
 * Additional insureds (migration 1130, finding A38-001, journey 43): the parties a certificate of
 * insurance names, the parties an org requires its vendors to name (org-wide or for one project),
 * the derived checks, and the reviewer's verification step on an onboarding item. Reads go through
 * row level security; the verification step is app.verify_onboarding_insureds.
 */

export type EndorsementKind = Database["app"]["Enums"]["endorsement_kind"];

export const ENDORSEMENT_KINDS: readonly EndorsementKind[] = enums.endorsementKind;

export interface CertificateInsured {
  readonly id: string;
  readonly certificateId: string;
  readonly insuredName: string;
  readonly endorsementKind: EndorsementKind;
}

/** Insureds named on the given certificates. */
export async function listCertificateInsureds(
  db: XosClient,
  certificateIds: readonly string[],
): Promise<Result<CertificateInsured[]>> {
  if (certificateIds.length === 0) return ok([]);
  return readRows(
    db
      .from("insurance_certificate_insureds")
      .select("id, certificate_id, insured_name, endorsement_kind")
      .in("certificate_id", [...certificateIds])
      .is("deleted_at", null)
      .order("insured_name"),
    (row) => ({
      id: row.id,
      certificateId: row.certificate_id,
      insuredName: row.insured_name,
      endorsementKind: row.endorsement_kind,
    }),
  );
}

export async function addCertificateInsured(
  db: XosClient,
  input: { certificateId: string; insuredName: string; endorsementKind: EndorsementKind },
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("insurance_certificate_insureds")
      .insert({
        certificate_id: input.certificateId,
        insured_name: input.insuredName.trim(),
        endorsement_kind: input.endorsementKind,
      } as Database["app"]["Tables"]["insurance_certificate_insureds"]["Insert"])
      .select("id")
      .single(),
  );
}

export async function removeCertificateInsured(db: XosClient, id: string): Promise<Result<null>> {
  return touched(
    db.from("insurance_certificate_insureds").update(deletedNow()).eq("id", id).select("id"),
  );
}

export interface RequiredInsured {
  readonly id: string;
  /** Null for every project of the org. */
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly insuredName: string;
  readonly endorsementKind: EndorsementKind;
}

export async function listRequiredInsureds(
  db: XosClient,
  orgId: string,
): Promise<Result<RequiredInsured[]>> {
  return readRows(
    db
      .from("required_additional_insureds")
      .select("id, project_id, insured_name, endorsement_kind, project:projects(name)")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("insured_name"),
    (row) => ({
      id: row.id,
      projectId: row.project_id,
      projectName: (row.project as { name: string } | null)?.name ?? null,
      insuredName: row.insured_name,
      endorsementKind: row.endorsement_kind,
    }),
  );
}

export async function addRequiredInsured(
  db: XosClient,
  input: {
    orgId: string;
    projectId: string | null;
    insuredName: string;
    endorsementKind: EndorsementKind;
  },
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("required_additional_insureds")
      .insert({
        org_id: input.orgId,
        project_id: input.projectId,
        insured_name: input.insuredName.trim(),
        endorsement_kind: input.endorsementKind,
      })
      .select("id")
      .single(),
  );
}

export async function removeRequiredInsured(db: XosClient, id: string): Promise<Result<null>> {
  return touched(
    db.from("required_additional_insureds").update(deletedNow()).eq("id", id).select("id"),
  );
}

export interface InsuredCheck {
  readonly requiredInsuredId: string;
  readonly insuredName: string;
  readonly endorsementKind: EndorsementKind;
  readonly projectSpecific: boolean;
  /** The current certificate naming the party; null when it is missing. */
  readonly namedOnCertificateId: string | null;
}

/** Each required insured for a vendor engagement, with the current certificate naming it. */
export async function listEngagementInsuredChecks(
  db: XosClient,
  engagementId: string,
): Promise<Result<InsuredCheck[]>> {
  return readRows(
    db
      .from("engagement_insured_checks")
      .select(
        "required_insured_id, insured_name, endorsement_kind, project_specific, named_on_certificate_id",
      )
      .eq("engagement_id", engagementId)
      .order("insured_name"),
    (row) => ({
      requiredInsuredId: row.required_insured_id ?? "",
      insuredName: row.insured_name ?? "",
      endorsementKind: (row.endorsement_kind ?? "Additional Insured") as EndorsementKind,
      projectSpecific: row.project_specific === true,
      namedOnCertificateId: row.named_on_certificate_id,
    }),
  );
}

export interface CertificateCheck {
  readonly certificateId: string;
  readonly insuredCount: number;
  readonly requiredCount: number;
  readonly missingCount: number;
  readonly insuredsVerified: boolean;
}

export async function listCertificateChecks(
  db: XosClient,
  orgId: string,
): Promise<Result<CertificateCheck[]>> {
  return readRows(
    db
      .from("insurance_certificate_checks")
      .select("certificate_id, insured_count, required_count, missing_count, insureds_verified")
      .eq("org_id", orgId),
    (row) => ({
      certificateId: row.certificate_id ?? "",
      insuredCount: row.insured_count ?? 0,
      requiredCount: row.required_count ?? 0,
      missingCount: row.missing_count ?? 0,
      insuredsVerified: row.insureds_verified === true,
    }),
  );
}

export interface InsuredVerification {
  readonly outcome: Database["app"]["Enums"]["verification_outcome"];
  readonly missing: readonly string[];
}

/** The reviewer's additional insureds step on one onboarding item. */
export async function verifyOnboardingInsureds(
  db: XosClient,
  itemId: string,
): Promise<Result<InsuredVerification>> {
  const result = await rpcValue(db.rpc("verify_onboarding_insureds", { p_item_id: itemId }));
  if (!result.ok) return result;
  const value = result.data as { outcome?: unknown; missing?: unknown };
  if (value.outcome !== "Passed" && value.outcome !== "Failed") {
    return fail({ kind: "unexpected", message: "verify_onboarding_insureds returned no outcome" });
  }
  return ok({
    outcome: value.outcome,
    missing: Array.isArray(value.missing) ? value.missing.map(String) : [],
  });
}
