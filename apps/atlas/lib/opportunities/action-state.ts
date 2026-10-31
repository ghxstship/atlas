import type { DataError } from "@xos/data";

/**
 * What every Opportunities server action answers: a catalog key under `opportunities.errors` (with the database rule
 * for refusals the catalog has no sentence for), field errors under `opportunities.fieldErrors`, the typed values so the
 * form keeps them, and a signing link shown once.
 */
export interface OpportunityActionState {
  readonly ok?: boolean;
  readonly error?: string;
  readonly rule?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, string>>;
  readonly link?: { readonly url: string; readonly accessCode: string; readonly expiresAt: string };
}

/** Refusal rules with their own sentence in the catalog; any other rule reads the generic refusal with its code. */
export const KNOWN_RULES: ReadonlySet<string> = new Set([
  "requisition_required",
  "requisition_not_approved",
  "requisition_mismatch",
  "requisition_missing",
  "pay_range_required",
  "plan_feature_unavailable",
  "opportunity_jurisdiction_unknown",
  "bid_deadline_required",
  "opportunity_published_terms",
  "opportunity_removed",
  "opportunity_transition_not_allowed",
  "opportunity_state_conflict",
  "application_transition_not_allowed",
  "application_state_conflict",
  "offer_application_state",
  "offer_not_your_turn",
  "offer_expired",
  "offer_expiry_past",
  "sod_offer_self",
  "offer_not_accepted",
  "offer_transition_not_allowed",
  "engagement_application_not_accepted",
  "engagement_already_created",
  "engagement_role_required",
  "engagement_work_terms",
  "onboarding_incomplete",
  "engagement_transition_not_allowed",
  "engagement_state_conflict",
  "engagement_document_transition_not_allowed",
  "engagement_document_party_signs",
  "engagement_document_signed",
  "document_token_state",
  "document_token_email",
  "document_token_validity",
  "sod_onboarding_self_verify",
  "verification_automatic",
  "pool_member_kind",
  "pool_member_own_org",
  "rating_engagement_not_complete",
  "rating_not_released",
  "sod_rating_self",
  "deliverable_return_reason",
  "sod_deliverable_self",
  "deliverable_transition_not_allowed",
  "XOS-ENG-1",
  "XOS-ENG-2",
  "XOS-ENG-3",
  "XOS-ENG-4",
  "XOS-ENG-5",
  "XOS-ENG-6",
  "plan_limit_exceeded",
  "transition_reason_required",
  "question_template_not_found",
  "question_template_not_draft",
]);

/** A repository error as the state a form shows. */
export function errorState(
  error: DataError,
  values?: Record<string, string>,
): OpportunityActionState {
  const base = values ? { values } : {};
  switch (error.kind) {
    case "refusal": {
      const key = error.rule.replace(/-/g, "_");
      return KNOWN_RULES.has(error.rule)
        ? { ...base, error: `refusal.${key}` }
        : { ...base, error: "refusal.generic", rule: error.rule };
    }
    case "not-found":
      return { ...base, error: "notFound" };
    case "conflict":
      return { ...base, error: "conflict" };
    case "invalid":
      return { ...base, error: "invalid" };
    default:
      return { ...base, error: "unexpected" };
  }
}
