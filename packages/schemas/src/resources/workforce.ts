/**
 * People, Crew and Credentials (Sections 4.2 and 7.4). Pay rates are Restricted (Section 8.3).
 */
import * as c from "../common/canon-codes.ts";
import * as f from "../common/fields.ts";
import { RateType } from "../common/enums.ts";
import { defineResource } from "../common/resource.ts";

// People

export const RoleAssignment = defineResource({
  name: "RoleAssignment",
  table: "app.role_assignments",
  description: "A canon workforce role staffed on a project, with its staffing ratio basis.",
  immutable: ["project_id"],
  fields: {
    project_id: f.ref("project"),
    role_code: c.RoleCode,
    scope_node_id: f.ref("scope node").nullable(),
    person_id: f.ref("assigned person").nullable(),
    headcount: f.int("Positions required.", 4, 1),
    ratio_basis: f
      .text("Staffing ratio basis used to size the role.", "1 per 250 guests")
      .nullable(),
  },
});

export const Requisition = defineResource({
  name: "Requisition",
  table: "app.requisitions",
  description: "A staffing or purchase requisition, approved before an opportunity is published.",
  immutable: ["project_id"],
  serverSet: ["requisition_state"],
  fields: {
    project_id: f.ref("project"),
    title: f.text("Requisition title.", "Stagehands for Load-In"),
    role_code: c.RoleCode.nullable(),
    urid: c.UridAtAnyGrain.nullable(),
    positions: f.int("Positions requested.", 12, 1),
    requisition_state: f.stateLabel("Requisition state.", "Sourcing"),
    budget_minor: f.money("Budgeted cost.", 960000),
    currency: f.currency(),
  },
});

export const Offer = defineResource({
  name: "Offer",
  table: "app.offers",
  description: "Terms issued to a person or organization: accepted, countered or declined.",
  serverSet: ["offer_state", "responded_at"],
  immutable: ["application_id"],
  fields: {
    application_id: f.ref("application").nullable(),
    person_id: f.ref("offered person").nullable(),
    organization_id: f.ref("offered organization").nullable(),
    rate_type: RateType,
    rate_minor: f.money("Offered rate.", 45000),
    currency: f.currency(),
    expires_at: f.instant("When the offer lapses."),
    offer_state: f.stateLabel("Offer state.", "Active"),
    responded_at: f.instant("When the offer was answered.").nullable(),
  },
  restricted: ["rate_minor"],
});

export const Agreement = defineResource({
  name: "Agreement",
  table: "app.agreements",
  description:
    "A contractor MSA, offer letter or crew agreement with token signing. A signed agreement cannot be revoked or unsigned.",
  serverSet: ["agreement_state", "signed_at"],
  fields: {
    engagement_id: f.ref("engagement").nullable(),
    title: f.text("Agreement title.", "Crew Agreement 2026"),
    document_id: f.ref("agreement document"),
    agreement_state: f.stateLabel("Agreement state.", "Active"),
    signed_at: f.instant("When the agreement was signed.").nullable(),
  },
});

// Crew

export const Shift = defineResource({
  name: "Shift",
  table: "app.shifts",
  description: "A staffed crew block. A shift cannot end before it starts.",
  immutable: ["project_id"],
  serverSet: ["shift_state"],
  fields: {
    project_id: f.ref("project"),
    record_id: f.ref("Shift record").nullable(),
    role_code: c.RoleCode,
    person_id: f.ref("assigned person").nullable(),
    engagement_id: f.ref("engagement").nullable(),
    starts_at: f.instant("Call time."),
    ends_at: f.instant("Wrap time."),
    geofence_id: f.ref("geofence for clock in").nullable(),
    shift_state: f.stateLabel("Shift state.", "Scheduled"),
  },
});

export const ShiftSwap = defineResource({
  name: "ShiftSwap",
  table: "app.shift_swaps",
  description: "A swap request. A crew member cannot approve their own swap.",
  immutable: ["shift_id"],
  serverSet: ["swap_state", "requested_by", "decided_by", "decided_at"],
  fields: {
    shift_id: f.ref("shift"),
    requested_by: f.ref("requesting person"),
    proposed_person_id: f.ref("proposed replacement").nullable(),
    swap_state: f.stateLabel("Swap state.", "Proposed"),
    decided_by: f.ref("approver").nullable(),
    decided_at: f.instant("When it was decided.").nullable(),
  },
});

export const TimeEntry = defineResource({
  name: "TimeEntry",
  table: "app.time_entries",
  description:
    "A time entry. Entries cannot overlap for one person; forgotten clock-outs close at 16 hours and are flagged.",
  immutable: ["person_id"],
  serverSet: ["auto_closed"],
  fields: {
    person_id: f.ref("person"),
    shift_id: f.ref("shift").nullable(),
    clock_in_at: f.instant("Clock in."),
    clock_out_at: f.instant("Clock out.").nullable(),
    break_minutes: f.int("Break minutes.", 30),
    latitude: f.latitude().nullable(),
    longitude: f.longitude().nullable(),
    auto_closed: f.bool("Whether the entry was closed automatically at 16 hours.", false),
    kiosk_device_id: f.ref("kiosk device").nullable(),
  },
});

export const TimeEntryCorrection = defineResource({
  name: "TimeEntryCorrection",
  table: "app.time_entry_corrections",
  description: "A requested correction to a time entry.",
  immutable: ["time_entry_id"],
  serverSet: ["correction_state"],
  fields: {
    time_entry_id: f.ref("time entry"),
    clock_in_at: f.instant("Corrected clock in.").nullable(),
    clock_out_at: f.instant("Corrected clock out.").nullable(),
    reason: f.longText("Why the correction is needed.", "Forgot to clock out at wrap."),
    correction_state: f.stateLabel("Correction state.", "Proposed"),
  },
});

export const TimeEntryAudit = defineResource({
  name: "TimeEntryAudit",
  table: "app.time_entry_audit",
  description: "An append-only audit row for a time entry change.",
  serverSet: ["time_entry_id", "field", "from_value", "to_value", "changed_at"],
  fields: {
    time_entry_id: f.ref("time entry"),
    field: f.code("Changed field.", "clock_out_at"),
    from_value: f.text("Previous value.", "2026-10-08T23:00:00Z").nullable(),
    to_value: f.text("New value.", "2026-10-08T23:30:00Z").nullable(),
    changed_at: f.instant("When it changed."),
  },
});

export const Timesheet = defineResource({
  name: "Timesheet",
  table: "app.timesheets",
  description:
    "A timesheet for one person and pay period. An approval is voided when its hours change.",
  immutable: ["person_id", "pay_period_id"],
  serverSet: ["timesheet_state", "total_hours"],
  fields: {
    person_id: f.ref("person"),
    pay_period_id: f.ref("pay period"),
    timesheet_state: f.stateLabel("Timesheet state.", "In Review"),
    total_hours: f.quantity("Total hours, derived from time entries.", 41.5),
  },
});

export const TimesheetApproval = defineResource({
  name: "TimesheetApproval",
  table: "app.timesheet_approvals",
  description: "An approval decision on a timesheet. The submitter cannot approve it.",
  immutable: ["timesheet_id"],
  serverSet: ["approver_id", "decided_at", "voided"],
  fields: {
    timesheet_id: f.ref("timesheet"),
    approver_id: f.ref("approver"),
    decision: f.stateLabel("Decision.", "Approved"),
    decided_at: f.instant("When it was decided."),
    voided: f.bool("Whether the approval was voided by an hours change.", false),
  },
});

export const KioskDevice = defineResource({
  name: "KioskDevice",
  table: "app.kiosk_devices",
  description: "A shared device in kiosk mode. Worker PINs are stored hashed and never returned.",
  fields: {
    name: f.text("Device name.", "Gate A Kiosk"),
    venue_id: f.ref("venue").nullable(),
    active: f.bool("Whether the kiosk accepts punches.", true),
  },
});

export const RateCard = defineResource({
  name: "RateCard",
  table: "app.rate_cards",
  description: "A labor rate card.",
  fields: {
    name: f.text("Rate card name.", "Local Stagehand Rates 2026"),
    currency: f.currency(),
    effective_from: f.date("First day the card applies."),
    effective_to: f.date("Last day the card applies.").nullable(),
  },
});

export const RateCardLine = defineResource({
  name: "RateCardLine",
  table: "app.rate_card_lines",
  description: "A rate card line by role.",
  immutable: ["rate_card_id"],
  restricted: ["rate_minor"],
  fields: {
    rate_card_id: f.ref("rate card"),
    role_code: c.RoleCode,
    rate_type: RateType,
    rate_minor: f.money("Rate.", 4500),
    currency: f.currency(),
  },
});

export const PayRate = defineResource({
  name: "PayRate",
  table: "app.pay_rates",
  description: "An append-only pay rate ledger entry for a person. Restricted.",
  immutable: ["person_id"],
  restricted: ["rate_minor"],
  fields: {
    person_id: f.ref("person"),
    role_code: c.RoleCode.nullable(),
    rate_type: RateType,
    rate_minor: f.money("Pay rate.", 5200),
    currency: f.currency(),
    effective_from: f.date("First day the rate applies."),
  },
});

export const OvertimeRule = defineResource({
  name: "OvertimeRule",
  table: "app.overtime_rules",
  description: "An overtime rule by jurisdiction.",
  fields: {
    name: f.text("Rule name.", "Daily Overtime After 8 Hours"),
    jurisdiction_id: c.JurisdictionId,
    threshold_hours: f.quantity("Hours after which the multiplier applies.", 8),
    multiplier: f.quantity("Pay multiplier.", 1.5),
    period: f.code("Threshold period.", "day"),
  },
});

export const UnionLocalRate = defineResource({
  name: "UnionLocalRate",
  table: "app.union_local_rates",
  description: "A union local's scale rate for a role.",
  restricted: ["rate_minor"],
  fields: {
    union_local: f.text("Union local.", "Local 500"),
    role_code: c.RoleCode,
    rate_minor: f.money("Scale rate per hour.", 5600),
    currency: f.currency(),
    effective_from: f.date("First day the rate applies."),
  },
});

export const WageDetermination = defineResource({
  name: "WageDetermination",
  table: "app.wage_determinations",
  description: "A prevailing wage determination by jurisdiction.",
  fields: {
    jurisdiction_id: c.JurisdictionId,
    reference: f.code("Determination reference.", "FL20260001"),
    role_code: c.RoleCode,
    rate_minor: f.money("Prevailing rate per hour.", 4800),
    currency: f.currency(),
  },
});

export const PayPeriod = defineResource({
  name: "PayPeriod",
  table: "app.pay_periods",
  description: "A pay period. A posted pay period cannot reopen.",
  serverSet: ["pay_period_state"],
  fields: {
    starts_on: f.date("First day."),
    ends_on: f.date("Last day."),
    pay_period_state: f.stateLabel("Pay period state.", "Open"),
  },
});

export const PayrollRun = defineResource({
  name: "PayrollRun",
  table: "app.payroll_runs",
  description: "A payroll run. It cannot jump from Draft to Accepted.",
  immutable: ["pay_period_id"],
  serverSet: ["payroll_run_state", "gross_total"],
  fields: {
    pay_period_id: f.ref("pay period"),
    payroll_run_state: f.stateLabel("Payroll run state.", "Draft"),
    gross_total: f.money("Gross pay total, derived.", 4825000),
    currency: f.currency(),
  },
});

export const PayrollLine = defineResource({
  name: "PayrollLine",
  table: "app.payroll_lines",
  description: "A payroll line, derived from approved timesheets.",
  restricted: ["amount_minor"],
  serverSet: [
    "payroll_run_id",
    "person_id",
    "earning_code_id",
    "hours",
    "amount_minor",
    "currency",
  ],
  fields: {
    payroll_run_id: f.ref("payroll run"),
    person_id: f.ref("person"),
    earning_code_id: f.ref("earning code"),
    hours: f.quantity("Hours.", 8),
    amount_minor: f.money("Line amount.", 41600),
    currency: f.currency(),
  },
});

export const PayrollExport = defineResource({
  name: "PayrollExport",
  table: "app.payroll_exports",
  description: "A payroll export file for a payroll provider.",
  immutable: ["payroll_run_id"],
  serverSet: ["export_state", "document_id"],
  fields: {
    payroll_run_id: f.ref("payroll run"),
    provider: f.code("Target payroll provider.", "payroll_csv"),
    export_state: f.stateLabel("Export state.", "Complete"),
    document_id: f.ref("export file").nullable(),
  },
});

export const EarningCode = defineResource({
  name: "EarningCode",
  table: "app.earning_codes",
  description: "An earning code mapped to the payroll provider.",
  fields: {
    earning_code: f.code("Earning code.", "REG"),
    name: f.text("Earning name.", "Regular Hours"),
    overtime: f.bool("Whether it is an overtime code.", false),
  },
});

export const PerDiem = defineResource({
  name: "PerDiem",
  table: "app.per_diems",
  description: "A per diem allowance for an engagement.",
  restricted: ["daily_amount_minor"],
  fields: {
    engagement_id: f.ref("engagement"),
    daily_amount_minor: f.money("Daily allowance.", 6500),
    currency: f.currency(),
    starts_on: f.date("First day."),
    ends_on: f.date("Last day."),
  },
});

export const TimeOffPolicy = defineResource({
  name: "TimeOffPolicy",
  table: "app.time_off_policies",
  description: "A time off policy.",
  fields: {
    name: f.text("Policy name.", "Paid Time Off"),
    accrual_hours_per_period: f.quantity("Hours accrued per pay period.", 3.08),
  },
});

export const TimeOffRequest = defineResource({
  name: "TimeOffRequest",
  table: "app.time_off_requests",
  description: "A time off request. The submitter cannot approve it.",
  immutable: ["person_id", "time_off_policy_id"],
  serverSet: ["time_off_state"],
  fields: {
    person_id: f.ref("person"),
    time_off_policy_id: f.ref("time off policy"),
    starts_on: f.date("First day off."),
    ends_on: f.date("Last day off."),
    time_off_state: f.stateLabel("Request state.", "Proposed"),
  },
});

// Credentials

export const CredentialCategory = defineResource({
  name: "CredentialCategory",
  table: "app.credential_categories",
  description: "A credential category, such as All Access or Artist.",
  fields: {
    name: f.text("Category name.", "All Access"),
    color_token: f.code("Design token for the badge color.", "badge.red"),
    position: f.int("Display order.", 1, 1),
  },
});

export const Credential = defineResource({
  name: "Credential",
  table: "app.credentials",
  description: "An issued credential. Credentials cannot be self-issued.",
  immutable: ["credential_category_id", "project_id"],
  serverSet: ["credential_state", "issued_by", "issued_at"],
  fields: {
    project_id: f.ref("project"),
    credential_category_id: f.ref("credential category"),
    person_id: f.ref("holder"),
    engagement_id: f.ref("engagement").nullable(),
    credential_state: f.stateLabel("Credential state.", "Active"),
    issued_by: f.ref("issuer"),
    issued_at: f.instant("When it was issued."),
    valid_from: f.instant("Start of validity."),
    valid_to: f.instant("End of validity."),
  },
});

export const AccessGridEntry = defineResource({
  name: "AccessGridEntry",
  table: "app.access_grid",
  description: "A zone by credential category access rule with a time window.",
  immutable: ["zone_id", "credential_category_id"],
  fields: {
    zone_id: f.ref("zone"),
    credential_category_id: f.ref("credential category"),
    allowed: f.bool("Whether the category may enter the zone.", true),
    window_starts_at: f.instant("Window start.").nullable(),
    window_ends_at: f.instant("Window end.").nullable(),
  },
});

export const AccessScan = defineResource({
  name: "AccessScan",
  table: "app.access_scans",
  description: "A credential scan at an access point, validated against the Access Grid.",
  immutable: ["zone_id", "credential_id"],
  serverSet: ["granted", "refusal_reason"],
  fields: {
    zone_id: f.ref("zone"),
    credential_id: f.ref("credential"),
    scanned_at: f.instant("When the scan happened."),
    granted: f.bool("Whether entry was granted.", true),
    refusal_reason: f.text("Why entry was refused.", "Outside the access window.").nullable(),
  },
});

export const Certification = defineResource({
  name: "Certification",
  table: "app.certifications",
  description: "A certification type, linked to canon compliance tags.",
  fields: {
    name: f.text("Certification name.", "OSHA 10"),
    tag_id: c.TagId.nullable(),
    issuer: f.text("Issuing body.", "OSHA"),
    validity_months: f.int("Months until expiry.", 60).nullable(),
  },
});

export const CertificationHolder = defineResource({
  name: "CertificationHolder",
  table: "app.certification_holders",
  description:
    "A person's certification with evidence and expiry. It cannot be self-verified and verifies publicly only with consent.",
  immutable: ["certification_id", "person_id"],
  serverSet: ["verified_at", "verified_by"],
  fields: {
    certification_id: f.ref("certification"),
    person_id: f.ref("holder"),
    evidence_document_id: f.ref("evidence document").nullable(),
    expires_on: f.date("Expiry date.").nullable(),
    verified_at: f.instant("When it was verified.").nullable(),
    verified_by: f.ref("verifier").nullable(),
    public_verification_consent: f.bool("Whether the holder allows public verification.", false),
  },
});
