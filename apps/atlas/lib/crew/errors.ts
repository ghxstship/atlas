import type { DataError } from "@xos/data";
import type { Translate } from "@/lib/shell/translate";

/**
 * Refusals the database raises for People and Crew writes (ADR 0008, SQLSTATE XR001), each with
 * catalog copy under `crew.refusals` that names the rule and the next action. A rule outside this
 * list still surfaces, by its code, through `crew.refusals.other`; nothing is swallowed.
 */
export const KNOWN_REFUSALS = [
  "shift_accept_rpc",
  "shift_already_claimed",
  "shift_already_filled",
  "shift_not_published",
  "shift_double_booked",
  "shift_state_conflict",
  "shift_transition_not_allowed",
  "shift_canceled",
  "shift_record",
  "shift_scope_project",
  "swap_not_on_shift",
  "swap_not_allowed",
  "swap_needs_approval",
  "shift_claim_waiting",
  "shift_claim_decided",
  "shift_claim_reason",
  "shift_claim_not_most_senior",
  "shift_claim_none",
  "sod_shift_claim_self",
  "shift_template_unknown",
  "shift_template_days",
  "availability_inside_notice",
  "punch_location_required",
  "punch_outside_geofence",
  "swap_stale",
  "swap_state_conflict",
  "sod_swap_requester",
  "time_entry_overlap",
  "time_entry_project",
  "time_entry_shift",
  "time_entry_immutable",
  "production_closed",
  "correction_immutable",
  "sod_approval_requester",
  "sod_timesheet_submitter",
  "timesheet_open_entry",
  "timesheet_immutable",
  "timesheet_state_conflict",
  "timesheet_transition_not_allowed",
  "pay_period_overlap",
  "pay_period_dates_locked",
  "pay_period_runs_open",
  "pay_period_transition_not_allowed",
  "pay_period_state_conflict",
  "pay_period_posted",
  "payroll_run_transition_not_allowed",
  "payroll_run_state_conflict",
  "payroll_run_not_calculated",
  "payroll_run_not_draft",
  "payroll_run_not_approved",
  "payroll_run_locked",
  "payroll_earning_code_missing",
  "payroll_overtime_code_missing",
  "payroll_holiday_code_missing",
  "payroll_rate_missing",
  "payroll_wage_rule_missing",
  "payroll_export_changed",
  "plan_feature_required",
  "export_restricted",
  "step_up_required",
  "spend_unpriced",
  "spend_authority_missing",
  "spend_authority_exceeded",
  "spend_approval_duplicate",
  "sod_time_off_requester",
  "time_off_state_conflict",
  "time_off_transition_not_allowed",
  "transition_reason_required",
  "time_zone_unknown",
  "requisition_unpriced",
  "requisition_locked",
  "requisition_state_conflict",
  "requisition_transition_not_allowed",
  "requisition_scope_project",
  "requisition_budget_project",
  "requisition_currency",
  "role_assignment_immutable",
  "role_assignment_basis",
  "role_assignment_requisition",
  "role_assignment_person",
  "role_assignment_state_conflict",
  "role_assignment_transition_not_allowed",
  "agreement_signed_permanent",
  "agreement_immutable",
  "agreement_locked",
  "agreement_state_conflict",
  "agreement_transition_not_allowed",
  "agreement_token_validity",
  "credential_self_issue",
  "certification_holder_immutable",
  "per_diem_one_worker",
  "per_diem_range",
  "per_diem_member_org",
  "per_diem_day_taken",
  "engagement_worker_person",
  "engagement_not_working",
] as const;

const KNOWN = new Set<string>(KNOWN_REFUSALS);

/** The sentence a form shows for a failed write, in the viewer's language. */
export function errorMessage(t: Translate, error: DataError): string {
  switch (error.kind) {
    case "refusal":
      return KNOWN.has(error.rule)
        ? t(`crew.refusals.${error.rule}`)
        : t("crew.refusals.other", { rule: error.rule });
    case "not-found":
      return t("crew.errors.notFound");
    case "conflict":
      return t("crew.errors.conflict");
    case "invalid":
      return t("crew.errors.invalid");
    default:
      return t("crew.errors.unexpected");
  }
}

/** The outcome kind for a refusal notice: plan and step-up refusals are REFUSE with a reason. */
export function isRefusal(error: DataError): boolean {
  return error.kind === "refusal";
}
