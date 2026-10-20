import { clientAddress, trustedProxyHops } from "@xos/data/client-address";
import type { LegalDocument } from "@/ia/generate";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";

/**
 * Legal acceptance at signup (Section 14.4): an org Owner accepts the documents legal/index.yaml
 * marks `org_owner_at_signup` (the Terms of Service and the DPA) when they create the org. Each
 * acceptance is written to the append-only app.legal_acceptances log by
 * app.record_legal_acceptances (migration 0850, RRR-73), which keeps the document, its version,
 * the database time, the IP address, the person and the org.
 */
/** Documents an org Owner accepts at signup, in registry order. */
export function ownerSignupDocuments(
  documents: readonly LegalDocument[] = LEGAL_DOCUMENTS,
): LegalDocument[] {
  return documents.filter(
    (d) => d.requiresAcceptanceAtSignup && d.acceptanceBy.includes("org_owner_at_signup"),
  );
}

/** The document versions an Owner accepts at signup, as the acceptance RPC takes them. */
export function signupAcceptances(
  documents: readonly LegalDocument[] = ownerSignupDocuments(),
): { slug: string; version: string }[] {
  return documents.map((d) => ({ slug: d.slug, version: d.version }));
}

/**
 * The client IP the platform saw: the X-Forwarded-For entry the trusted proxy appended, counted
 * from the right past `XOS_TRUSTED_PROXY_HOPS`, never the first entry, which the client writes
 * (finding A69-003; the org IP allow-list relies on it).
 */
export function clientIp(headers: Headers): string | null {
  return clientAddress(headers, trustedProxyHops(process.env["XOS_TRUSTED_PROXY_HOPS"]));
}
