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
  // R5: the producing org's names lock (G-142, migration 2656).
  "roster_locked",
  "roster_lock_engagement_closed",
  // R8: the party side asks for and shares out what its engagement needs (migration 2700, through 2693).
  "allocation_not_your_engagement",
  "allocation_entry_not_on_engagement",
  "allocation_not_requestable",
  "allocation_item_kind",
  "offering_not_offered",
  "offering_not_provided",
  "allocation_cap_engagement",
  "allocation_cap_person",
  "allocation_engagement_closed",
  "allocation_entry_not_live",
  "allocation_entry_not_accepted",
  "allocation_issued",
  "allocation_state_conflict",
  "allocation_not_pool",
  "allocation_not_split",
  "allocation_split_exceeds",
  "allocation_split_parts",
  "allocation_window",
  "allocation_quantity_positive",
  "allocation_quantity_whole",
  // R9: typed advance answers, party uploads, supplied sponsor assets, guest list caps and the naming
  // deadline (migrations 2710 to 2716).
  "advance_section_derived",
  "advance_section_role",
  "advance_section_open",
  "advance_recipient_engagement",
  "advance_line_limit",
  "advance_line_kind",
  "advance_line_person",
  "advance_line_window",
  "advance_line_roster_entry",
  "advance_file_document",
  "advance_answer_length",
  "advance_typed_answer_rpc",
  "party_upload_missing",
  "party_upload_checksum",
  "guest_list_cap",
  "sponsor_asset_files_required",
  "sponsor_asset_files_invalid",
  "sponsor_asset_source",
  "credential_names_closed",
  // A86 settings surfaces: personal API tokens, step-up, company ownership and notification defaults.
  "personal_tokens_off",
  "personal_token_scope_not_held",
  "personal_token_limit",
  "personal_token_expiry",
  "personal_token_revoked",
  "step_up_required",
  "sole_account_owner",
  "notification_channel_outside",
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
