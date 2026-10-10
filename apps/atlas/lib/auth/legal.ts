import type { LegalDocument } from "@/ia/generate";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";

/**
 * Legal acceptance at signup (Section 14.4): an org Owner accepts the documents legal/index.yaml
 * marks `org_owner_at_signup` (the Terms of Service and the DPA) when they create the org. Each
 * acceptance keeps the document, its version, the time, the IP address and the user.
 *
 * Until A21 and A02 add an acceptance table and RPC, acceptances are recorded on the Supabase Auth
 * user (`user_metadata.legal_acceptances`), which only that user and the platform can write. The
 * record shape below is the one the table will take, so moving it is a copy.
 */
export interface LegalAcceptance {
  readonly document: string;
  readonly version: string;
  readonly accepted_at: string;
  readonly ip: string | null;
  readonly org_id: string;
}

/** Documents an org Owner accepts at signup, in registry order. */
export function ownerSignupDocuments(
  documents: readonly LegalDocument[] = LEGAL_DOCUMENTS,
): LegalDocument[] {
  return documents.filter(
    (d) => d.requiresAcceptanceAtSignup && d.acceptanceBy.includes("org_owner_at_signup"),
  );
}

/** The acceptance records for one org, appended to what the user already accepted. */
export function withAcceptances(
  existing: unknown,
  input: { readonly orgId: string; readonly ip: string | null; readonly at: Date },
  documents: readonly LegalDocument[] = ownerSignupDocuments(),
): LegalAcceptance[] {
  const prior = Array.isArray(existing) ? (existing as LegalAcceptance[]) : [];
  const added = documents.map((d) => ({
    document: d.slug,
    version: d.version,
    accepted_at: input.at.toISOString(),
    ip: input.ip,
    org_id: input.orgId,
  }));
  return [...prior, ...added];
}

/** The client IP the platform saw, from the proxy chain headers. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || null;
  return headers.get("x-real-ip");
}
