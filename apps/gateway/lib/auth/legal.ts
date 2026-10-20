import type { XosClient } from "@xos/data/client";
import { clientAddress, trustedProxyHops } from "@xos/data/client-address";
import { recordLegalAcceptances } from "@xos/data/settings";

/**
 * Legal acceptance at Gateway account creation (Section 14.4, finding A59-025). legal/index.yaml
 * marks the Worker Terms `external_party_at_account_creation`: a person creating a Gateway account
 * accepts them, and reads the Privacy Policy, before the account exists. The versions below mirror
 * the registry; test/legal.test.ts fails when they drift.
 *
 * Supabase creates the account before anyone is signed in, so the accepted versions travel in the
 * new user's metadata and are written to the append-only app.legal_acceptances log (migration
 * 0850, with the version, the database time, the IP and the person) as soon as a session exists:
 * at once after a password sign-up, or when the email link comes back for a link sign-up.
 */

export interface GatewayLegalDocument {
  readonly slug: string;
  readonly title: string;
  readonly version: string;
  /** Accepted at account creation (true) or linked as a notice to read (false). */
  readonly accept: boolean;
}

/** The documents Gateway links at account creation, in the order the sign-up form names them. */
export const GATEWAY_LEGAL_DOCUMENTS: readonly GatewayLegalDocument[] = [
  { slug: "worker-terms", title: "Worker Terms", version: "1.0.0-draft", accept: true },
  { slug: "privacy-policy", title: "Privacy Policy", version: "1.0.0-draft", accept: false },
];

/** A document Gateway publishes at /legal/{slug}, or undefined. */
export function gatewayLegalDocument(slug: string): GatewayLegalDocument | undefined {
  return GATEWAY_LEGAL_DOCUMENTS.find((d) => d.slug === slug);
}

export interface Acceptance {
  readonly slug: string;
  readonly version: string;
}

/** The versions a new account accepts, as the user metadata carries them until a session exists. */
export function signUpAcceptances(
  documents: readonly GatewayLegalDocument[] = GATEWAY_LEGAL_DOCUMENTS,
): Acceptance[] {
  return documents.filter((d) => d.accept).map((d) => ({ slug: d.slug, version: d.version }));
}

/** The user metadata key that holds acceptances not yet written to the log. */
export const PENDING_ACCEPTANCES = "pending_legal_acceptances";

/** Acceptances waiting in user metadata; anything malformed is ignored. */
export function pendingAcceptances(metadata: unknown): Acceptance[] {
  const value =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)[PENDING_ACCEPTANCES]
      : undefined;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { slug, version } = item as Record<string, unknown>;
    return typeof slug === "string" && typeof version === "string" ? [{ slug, version }] : [];
  });
}

/**
 * The account-creation documents the signed-in person has not accepted yet. A provider such as
 * Google creates the account at its first sign-in, before any form (ADR 0036), so Gateway asks
 * for them right after that sign-in, on /auth/terms. Acceptances waiting in the metadata are about
 * to be written, so they count as given. If the log cannot be read, everything counts as missing:
 * accepting twice adds a second entry to the log, which does no harm.
 */
export async function missingSignUpAcceptances(db: XosClient): Promise<Acceptance[]> {
  const required = signUpAcceptances();
  const { data } = await db.auth.getUser();
  if (!data.user || pendingAcceptances(data.user.user_metadata).length > 0) return [];
  const { data: rows, error } = await db
    .from("legal_acceptances")
    .select("document_slug")
    .in(
      "document_slug",
      required.map((d) => d.slug),
    );
  if (error) return required;
  const accepted = new Set(rows.map((row) => row.document_slug));
  return required.filter((d) => !accepted.has(d.slug));
}

/**
 * The client IP the platform saw: the entry the trusted proxy appended to X-Forwarded-For, never
 * the first entry, which the client writes (A69-003).
 */
export function clientIp(headers: Headers): string | null {
  return clientAddress(headers, trustedProxyHops(process.env["XOS_TRUSTED_PROXY_HOPS"]));
}

/**
 * Writes the signed-in person's pending acceptances to app.legal_acceptances (a personal
 * acceptance, no org) and clears them from the metadata. A failure leaves them pending, so the
 * next sign-in tries again; it never blocks the person.
 */
export async function recordPendingAcceptances(db: XosClient, ip: string | null): Promise<void> {
  const { data } = await db.auth.getUser();
  const pending = pendingAcceptances(data.user?.user_metadata);
  if (!data.user || pending.length === 0) return;
  const recorded = await recordLegalAcceptances(db, {
    orgId: null,
    documents: pending,
    clientIp: ip,
  });
  if (!recorded.ok) return;
  await db.auth.updateUser({ data: { [PENDING_ACCEPTANCES]: null } });
}
