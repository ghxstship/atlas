import type { DataError, Result } from "@xos/data/gateway";
import { observability } from "@/lib/observability";

/**
 * What a Gateway server action returns to the page: success, or a catalog key under
 * `gateway.outcomes` that names the problem and the fix (Section 11.10, rule 11). Database
 * refusals (SQLSTATE XR001) keep their rule code so known rules get specific copy; anything else
 * maps to a generic outcome, and unexpected failures are logged on the server, never swallowed.
 */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly outcome: string };

/** Refusal rules with their own copy in `gateway.outcomes.refusals`. */
export const KNOWN_REFUSALS = [
  "application_deadline_passed",
  "opportunity_not_available",
  "application_not_editable",
  "application_profile_share",
  "lifecycle_transition",
  "lifecycle_conflict",
  "representation_not_acceptable",
  "representation_expiry",
  "representation_scope_required",
  "representative_not_in_account",
  "profile_share_fields",
  "profile_share_engagement",
  "rating_engagement_not_complete",
  "rating_immutable",
  "tin_format",
  "tax_form_payee",
  "sod_self_grant",
  "account_role_band",
  "slug_taken",
  "slug_reserved",
  "cross_org_reference",
  "supplier_diversity_no_program",
  "time_zone_unknown",
  // R1: an advance section takes one answer until it is returned (migration 2604).
  "advance_answer_pending",
  // R2: the vendor submits a Proposed submittal or resubmits a Returned one, with a note (migration 2610).
  "submittal_response",
  "submittal_note_length",
  // R4: the crew roster, account membership acceptance and invitations (migrations 2630 to 2638).
  "roster_closed",
  "roster_role_type",
  "roster_person_not_in_team",
  "roster_person_is_engaged",
  "roster_person_duplicate",
  "roster_arrival_window",
  "roster_role_unknown",
  "roster_entry_not_editable",
  "roster_empty_submit",
  "roster_self_entry_fixed",
  "roster_entry_withdrawn",
  "roster_replacement_invalid",
  "roster_response_not_yours",
  "roster_entry_not_accepted",
  "invite_expiry_range",
  "invitation_email",
  "invitation_not_yours",
  "invitation_closed",
  "account_membership_not_yours",
  "account_membership_unconfirmed",
  "assignment_account_mismatch",
  // A86 settings surfaces: personal API tokens, step-up, company ownership and notification defaults.
  "personal_tokens_off",
  "personal_token_scope_not_held",
  "personal_token_limit",
  "personal_token_expiry",
  "personal_token_revoked",
  "step_up_required",
  "sole_account_owner",
  "notification_channel_outside",
  // P5 badge photos (2822): the holder records a photo from their own folder while they hold a live credential.
  "credential_photo_path",
  "credential_photo_no_credential",
  "credential_photo_notice",
] as const;

export function outcomeFor(error: DataError): string {
  switch (error.kind) {
    case "refusal":
      return (KNOWN_REFUSALS as readonly string[]).includes(error.rule)
        ? `refusals.${error.rule}`
        : "refused";
    case "not-found":
      return "notFound";
    case "conflict":
      return "conflict";
    case "invalid":
      return "invalid";
    case "unexpected":
      observability.logger.error("Gateway action failed", { error: error });
      return "unexpected";
  }
}

export function toAction<T>(result: Result<T>): ActionResult {
  return result.ok ? { ok: true } : { ok: false, outcome: outcomeFor(result.error) };
}
