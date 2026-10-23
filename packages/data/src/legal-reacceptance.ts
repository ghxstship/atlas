import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Re-acceptance after a material change to a legal document (Section 14.4,
 * legal/policies/change-management.md section 6, finding A65-014; migration 1383). The platform team
 * announces the new version at least 30 days before it takes effect; from then on the shells ask for
 * it: in Atlas, whoever may accept for the org (org.legal.accept), until the org accepts; in Gateway,
 * each person who accepted an earlier version of a personal document such as the Worker Terms, until
 * they accept the new one. Acceptance goes through recordLegalAcceptances (migration 0850).
 */

/** Days of notice before a material change takes effect. */
export const LEGAL_NOTICE_DAYS = 30;

export interface LegalReacceptance {
  readonly documentSlug: string;
  readonly documentVersion: string;
  readonly summary: string;
  readonly noticedAt: string;
  /** Date the new version takes effect, YYYY-MM-DD. */
  readonly effectiveOn: string;
  /** From the effective date on: the notice period is over. */
  readonly required: boolean;
}

/**
 * Announced changes the signed-in person is asked to accept: the org's documents with an org id,
 * the person's own documents without one. Empty for anyone the database does not ask.
 */
export async function listPendingReacceptances(
  db: XosClient,
  orgId: string | null,
): Promise<Result<LegalReacceptance[]>> {
  const { data, error } = await db.rpc(
    "pending_legal_reacceptances",
    orgId === null ? {} : { p_org_id: orgId },
  );
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      documentSlug: row.document_slug,
      documentVersion: row.document_version,
      summary: row.summary,
      noticedAt: row.noticed_at,
      effectiveOn: row.effective_on,
      required: row.required,
    })),
  );
}

/** Whole days from `today` until the change takes effect; 0 once it has. Dates are UTC. */
export function daysUntilEffective(effectiveOn: string, today: Date = new Date()): number {
  const effective = Date.parse(`${effectiveOn}T00:00:00Z`);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.round((effective - start) / 86_400_000));
}
