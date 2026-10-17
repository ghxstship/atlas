import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Pay-transparency rules (A43, finding A38-006; Section 4.4.3, 14.9; migration 1125): platform legal
 * reference data read from app.pay_transparency_rules. Publishing a Contractor, Crew or Staff posting
 * without a pay range where a rule in force applies is refused in the database (pay_range_required).
 * Rows marked needsCounselReview are not yet confirmed by the owner with counsel.
 */
export interface PayTransparencyRule {
  readonly jurisdictionId: string;
  readonly requiresPayRange: boolean;
  readonly effectiveFrom: string;
  readonly citation: string;
  readonly appliesToRemote: boolean;
  readonly needsCounselReview: boolean;
}

export async function listPayTransparencyRules(
  db: XosClient,
): Promise<Result<PayTransparencyRule[]>> {
  const { data, error } = await db
    .from("pay_transparency_rules")
    .select(
      "jurisdiction_id, requires_pay_range, effective_from, citation, applies_to_remote, needs_counsel_review",
    )
    .order("jurisdiction_id")
    .order("effective_from", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      jurisdictionId: r.jurisdiction_id ?? "",
      requiresPayRange: r.requires_pay_range === true,
      effectiveFrom: r.effective_from ?? "",
      citation: r.citation ?? "",
      appliesToRemote: r.applies_to_remote === true,
      needsCounselReview: r.needs_counsel_review !== false,
    })),
  );
}
