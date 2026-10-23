import type { Database, XosClient } from "./client.ts";
import { Constants } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Supplier diversity certifications (Section 4.4.1, migration 1464, A65-031): self-declared by a
 * person or an external account, read and written only by the owner, shared one org at a time under
 * a separate supplier_diversity consent and only with an org that runs a supplier diversity program.
 * The certificate number is Restricted: write-only to the owner, who sees its last four characters;
 * an org reads it whole only with data.restricted.read.government_id. Org reads are audited.
 */

export type SupplierDiversityKind = Database["app"]["Enums"]["supplier_diversity_kind"];
export const SUPPLIER_DIVERSITY_KINDS = Constants.app.Enums.supplier_diversity_kind;

export interface SupplierDiversityShare {
  readonly shareId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly sharedAt: string;
}

export interface SupplierDiversityCertification {
  readonly id: string;
  readonly kind: SupplierDiversityKind;
  readonly certifyingBody: string;
  /** Last four characters of the Restricted certificate number; null when none was given. */
  readonly numberLast4: string | null;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly shares: readonly SupplierDiversityShare[];
}

function shares(value: unknown): SupplierDiversityShare[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (typeof v !== "object" || v === null) return [];
    const r = v as Record<string, unknown>;
    return typeof r["shareId"] === "string" && typeof r["orgId"] === "string"
      ? [
          {
            shareId: r["shareId"],
            orgId: r["orgId"],
            orgName: typeof r["orgName"] === "string" ? r["orgName"] : "",
            sharedAt: typeof r["sharedAt"] === "string" ? r["sharedAt"] : "",
          },
        ]
      : [];
  });
}

/** The signed-in person's own certifications, or an account's they are an Owner or Admin of. */
export async function listMySupplierDiversity(
  db: XosClient,
  accountId: string | null = null,
): Promise<Result<SupplierDiversityCertification[]>> {
  const { data, error } = await db.rpc(
    "my_supplier_diversity",
    accountId ? { p_account_id: accountId } : {},
  );
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      id: row.id,
      kind: row.diversity_kind,
      certifyingBody: row.certifying_body,
      numberLast4: row.certificate_number_last4,
      issuedOn: row.issued_on,
      expiresOn: row.expires_on,
      shares: shares(row.shares),
    })),
  );
}

export interface SupplierDiversityInput {
  /** The owner: the signed-in person (personId) or an external account (accountId). */
  readonly personId: string | null;
  readonly accountId: string | null;
  readonly kind: SupplierDiversityKind;
  readonly certifyingBody: string;
  readonly certificateNumber: string | null;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
}

/** Declares a certification; row level security admits only the owner. */
export async function addSupplierDiversity(
  db: XosClient,
  input: SupplierDiversityInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("supplier_diversity_certifications")
    .insert({
      person_id: input.accountId ? null : input.personId,
      account_id: input.accountId,
      diversity_kind: input.kind,
      certifying_body: input.certifyingBody.trim(),
      certificate_number: input.certificateNumber?.trim() || null,
      issued_on: input.issuedOn,
      expires_on: input.expiresOn,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a certification (soft delete); live shares stop with it, since the org reads only live rows. */
export async function removeSupplierDiversity(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db
    .from("supplier_diversity_certifications")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  return error ? fail(toDataError(error)) : ok(null);
}

export interface SupplierDiversityProgram {
  readonly orgId: string;
  readonly orgName: string;
}

/** Orgs that run a program among those the person (or the account) works with or applied to. */
export async function listSupplierDiversityPrograms(
  db: XosClient,
  accountId: string | null = null,
): Promise<Result<SupplierDiversityProgram[]>> {
  const { data, error } = await db.rpc(
    "supplier_diversity_programs",
    accountId ? { p_account_id: accountId } : {},
  );
  if (error) return fail(toDataError(error));
  return ok((data ?? []).map((row) => ({ orgId: row.org_id, orgName: row.org_name })));
}

/** Shares one certification with one org under supplier_diversity consent. */
export async function shareSupplierDiversity(
  db: XosClient,
  input: { readonly certificationId: string; readonly orgId: string },
): Promise<Result<{ shareId: string }>> {
  const { data, error } = await db.rpc("share_supplier_diversity", {
    p_certification_id: input.certificationId,
    p_org_id: input.orgId,
  });
  if (error) return fail(toDataError(error));
  return ok({ shareId: data });
}

/** Revokes a share at once; the consent is withdrawn with the org's last live share. */
export async function revokeSupplierDiversityShare(
  db: XosClient,
  shareId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_supplier_diversity_share", { p_share_id: shareId });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface SharedSupplierDiversity {
  readonly shareId: string;
  readonly certificationId: string;
  /** The person or company that shared it. */
  readonly ownerName: string;
  readonly ownerKind: "person" | "account";
  readonly kind: SupplierDiversityKind;
  readonly certifyingBody: string;
  /** The whole number for readers with the government identifier capability; otherwise null. */
  readonly certificateNumber: string | null;
  /** True when a number exists and is masked for this reader (Section 8.3). */
  readonly numberMasked: boolean;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly sharedAt: string;
}

/**
 * Certifications shared with an org, for its members holding vendors.vendor.read, while the org runs
 * a program. Every call is logged in each owner's access log and the org's audit ledger.
 */
export async function listSharedSupplierDiversity(
  db: XosClient,
  orgId: string,
): Promise<Result<SharedSupplierDiversity[]>> {
  const { data, error } = await db.rpc("shared_supplier_diversity", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      shareId: row.share_id,
      certificationId: row.certification_id,
      ownerName: row.account_name ?? row.person_name ?? "",
      ownerKind: row.account_id ? ("account" as const) : ("person" as const),
      kind: row.diversity_kind,
      certifyingBody: row.certifying_body,
      certificateNumber: row.certificate_number,
      numberMasked: row.certificate_number_masked ?? false,
      issuedOn: row.issued_on,
      expiresOn: row.expires_on,
      sharedAt: row.shared_at,
    })),
  );
}
