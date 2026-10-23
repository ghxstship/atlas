import type { DataError, Result } from "@xos/data/gateway";

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
      console.error("Gateway action failed", error);
      return "unexpected";
  }
}

export function toAction<T>(result: Result<T>): ActionResult {
  return result.ok ? { ok: true } : { ok: false, outcome: outcomeFor(result.error) };
}
