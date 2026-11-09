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
  // ADR 0164: a question cannot ask for what no consent step covers.
  "question_sensitive",
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
  "rating_dispute_decided",
  "rating_dispute_answered",
  "rating_dispute_response",
  "sod_rating_dispute_answer",
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
  "opportunity_hidden_client_named",
  "opportunity_hidden_client_published",
  "XOS_ENG_1",
  "XOS_ENG_2",
  "XOS_ENG_3",
  "XOS_ENG_4",
  "XOS_ENG_5",
  "XOS_ENG_6",
  "insureds_none_required",
  "insureds_vendor_only",
  "registration_page_pool",
  "registration_page_slug_fixed",
  "registration_page_minimum_age_fixed",
  "registration_page_not_draft",
  "registration_page_closed",
  "registration_question_fixed",
  "registration_not_found",
  "sod_registration_self",
  "registration_not_submitted",
  "registration_person_excluded",
  "registration_decide_batch",
  "registration_invite_limit",
  "document_template_fields",
  "document_template_kind",
  "document_template_rate_title",
  "document_template_in_use",
  "document_template_not_found",
  "document_batch_size",
  "document_batch_requirement",
  "document_batch_person",
  "document_merge_unresolved",
  "document_merge_rate_restricted",
  "document_batch_title",
  "document_batch_body",
  "document_batch_duplicate",
  "document_batch_no_item",
  "document_text_signed",
  "document_text_fixed",
  "document_text_sign_with_hash",
  "pool_invitation_pool",
  "pool_invitation_phone",
  "pool_invitation_duplicate",
  "pool_invitation_declined",
  "pool_invitation_daily_limit",
  "pool_invitation_answered",
  "pool_invitation_fixed",
  "pool_rate_not_permitted",
  "pool_rate_invalid",
  "invitation_email",
  "invite_expiry_range",
  "invitation_closed",
]);

/** Refusals that point at fields, with each field's key under `opportunities.fieldErrors` (3870). */
const RULE_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  opportunity_hidden_client_named: {
    title: "hiddenClientNamed",
    description: "hiddenClientNamed",
  },
  opportunity_hidden_client_published: { hideClientUntilBooked: "hiddenClientPublished" },
};

/** A repository error as the state a form shows. */
export function errorState(
  error: DataError,
  values?: Record<string, string>,
): OpportunityActionState {
  const base = values ? { values } : {};
  switch (error.kind) {
    case "refusal": {
      const key = error.rule.replace(/-/g, "_");
      const fields = RULE_FIELDS[error.rule];
      return KNOWN_RULES.has(error.rule)
        ? { ...base, error: `refusal.${key}`, ...(fields ? { fieldErrors: fields } : {}) }
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
