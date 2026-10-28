/**
 * Crew operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Crew resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Crew resources follow ADR 0023.
 *
 * A worker is a membership (staff) or an engagement (external crew, A03F 0940), never a person id:
 * every Crew row that names a worker carries `membership_id` and, where external crew can appear,
 * `engagement_id`.
 */
import { z } from "@hono/zod-openapi";
import { canonCodes, exampleOf, fields, maskable } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { fieldHistoryAction, shiftBulkActions } from "./parts/bulk-edit-and-history.ts";
import {
  all,
  editShape,
  orNull,
  putActions,
  removeActions,
  removeVerbs,
  setTable,
} from "../correct.ts";
import { itemAction, transition } from "../define.ts";
import type { ActionSpec, ResourceSpec } from "../types.ts";
import { crewFieldHomes } from "./parts/playbook-field-homes.ts";
import { crewFieldExposure } from "./parts/playbook-field-exposure.ts";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

/** The write form of a NOT NULL amount in integer minor units; read shapes keep money nullable (Section 3.7). */
const minor = (description: string, example: number) =>
  z
    .int()
    .min(0)
    .meta({
      description: `${description} Integer minor units of the row's currency.`,
      example,
      format: "int64",
    });

const membership = (what: string) =>
  orNull(fields.ref(`membership of ${what}; null for external crew, who carry an engagement`));
const engagement = (what: string) =>
  orNull(fields.ref(`engagement of ${what} when external crew; null for members`));

/** The Restricted fields of a corrected resource (Section 8.3). */
const restrict =
  (...names: readonly string[]) =>
  (spec: ResourceSpec): ResourceSpec => ({ ...spec, def: { ...spec.def, restricted: names } });

const SINCE = "1.0.0-draft.2";

/**
 * What `shifts.claim` returns: the shift, and the claim that waits for a supervisor when the project's
 * claiming rule (scheduling.open_shift_claiming, 1322) is approval or seniority.
 */
const shiftClaimResult = (shift: z.ZodObject) => {
  const claim = z
    .object({
      id: fields.uuid("Identifier of the waiting claim."),
      claim_state: label(
        ["Requested"],
        "State of the claim: Requested until a supervisor approves or rejects it.",
      ),
    })
    .meta({ description: "The claim that waits for a supervisor." });
  return shift
    .extend({
      claim: orNull(claim).meta({
        description:
          "The caller's waiting claim when the claiming rule is approval or seniority; null when the caller got the shift (first-come).",
      }),
    })
    .meta({
      id: "ShiftClaimResult",
      description:
        "The shift after a claim, with the caller's waiting claim when a supervisor decides it.",
      // A claim that waits: the shift stays Published with no one on it until a supervisor decides.
      example: {
        ...(exampleOf(shift) as Record<string, unknown>),
        membership_id: null,
        engagement_id: null,
        shift_state: "Published",
        claim: exampleOf(claim),
      },
    });
};

export const additions = defineAdditions("Crew", {
  actions: { shifts: [...shiftBulkActions, fieldHistoryAction("shift")] },
  corrections: [
    {
      id: "shift-worker-and-time-zone",
      since: SINCE,
      resources: ["shifts"],
      change:
        "The worker is `membership_id` (or `engagement_id`); adds `scope_node_id` and a required `time_zone`; removes `person_id` and `geofence_id`; `role_code` becomes nullable. `shift_state` is Draft, Published, Accepted or Canceled, the transition example becomes Draft to Published, and `shifts.claim` is added for published open shifts.",
      reason:
        "app.shifts (0340, 0940) names the worker by membership or engagement, stores the IANA time zone the times were entered in (NOT NULL) and an optional scope node, has no geofence column, and leaves the role NULL on an unstaffed block. The lifecycle of 0460 is Draft, Published, Accepted and Canceled; app.claim_open_shift (0460) lets anyone with crew.shift.read take a published open shift.",
      apply: all(
        editShape({
          remove: ["person_id", "geofence_id"],
          nullable: ["role_code"],
          add: {
            membership_id: { schema: membership("the person on the shift"), create: "optional" },
            scope_node_id: {
              schema: orNull(fields.ref("scope node of the same project, such as the show")),
              create: "optional",
            },
            time_zone: {
              schema: fields.timeZone("IANA time zone the call and wrap times are shown in."),
              create: "required",
            },
            shift_state: {
              schema: label(["Draft", "Published", "Accepted", "Canceled"], "Shift state."),
            },
          },
        }),
        putActions(
          [
            transition("Shift", ["Draft", "Published"]),
            itemAction("claim", {
              summary: "Claim an open shift",
              description:
                "Takes a published shift that has no one on it as the caller's own membership; the shift becomes Accepted. A held, unpublished or overlapping shift is refused (422).",
            }),
          ],
          { claim: "crew.shift.read" },
        ),
      ),
    },
    {
      id: "shift-swap-memberships",
      since: SINCE,
      resources: ["shiftSwaps"],
      change:
        "The parties are `requested_by_membership_id` (set from the shift) and `proposed_membership_id` (required); adds `project_id` (set from the shift); removes `requested_by`, `proposed_person_id`, `decided_by` and `decided_at`. `swap_state` is Proposed, Approved, Rejected or Canceled.",
      reason:
        "app.shift_swaps (0340, 0460) stores both parties as memberships (NOT NULL), only the person on the shift may ask (guard_shift_swap), and the project is copied from the shift for Compass sync. Decisions are rows of app.swap_state_transitions, not columns.",
      apply: editShape({
        remove: ["requested_by", "proposed_person_id", "decided_by", "decided_at"],
        add: {
          project_id: { schema: fields.ref("project of the shift, copied from it") },
          requested_by_membership_id: {
            schema: fields.ref("membership of the person on the shift who asks to swap"),
          },
          proposed_membership_id: {
            schema: fields.ref("membership of the person who would take the shift"),
            create: "required",
          },
          swap_state: {
            schema: label(["Proposed", "Approved", "Rejected", "Canceled"], "Swap state."),
          },
        },
      }),
    },
    {
      id: "time-entry-columns",
      since: SINCE,
      resources: ["timeEntries"],
      change:
        "`clock_in_at` and `clock_out_at` become `clock_in` and `clock_out`; the worker is `membership_id` or `engagement_id` on a required `project_id`; adds `source`, `auto_closed_at` and `needs_review`; removes `person_id`, `latitude`, `longitude` and `auto_closed`. Removes `timeEntries.startBreak` and `timeEntries.endBreak`.",
      reason:
        "app.time_entries (0340, 0940) names the columns `clock_in` and `clock_out`, belongs to a project, records the punch source and stamps `auto_closed_at` with `needs_review` when a forgotten clock-out closes at 16 hours. It keeps no coordinates, and breaks are `break_minutes` on the entry, not punches.",
      apply: all(
        editShape({
          rename: { clock_in_at: "clock_in", clock_out_at: "clock_out" },
          remove: ["person_id", "latitude", "longitude", "auto_closed"],
          add: {
            project_id: { schema: fields.ref("project worked"), create: "required", update: false },
            membership_id: { schema: membership("the person who worked"), create: "optional" },
            engagement_id: { schema: engagement("the person who worked"), create: "optional" },
            source: {
              schema: label(["Web", "Mobile", "Kiosk"], "Where the punch came from."),
              create: "optional",
            },
            auto_closed_at: {
              schema: orNull(
                fields.instant("When a forgotten clock-out was closed automatically at 16 hours."),
              ),
            },
            needs_review: {
              schema: fields.bool(
                "Whether the entry was closed automatically and awaits review.",
                false,
              ),
            },
          },
        }),
        removeActions("startBreak", "endBreak"),
      ),
    },
    {
      id: "time-entry-clock-in-punch",
      since: SINCE,
      resources: ["timeEntries"],
      components: ["schemas/TimeEntryClockInRequest"],
      change:
        "`timeEntries.clockIn` takes the punch that opens the entry: a required `project_id`, the optional `shift_id`, `engagement_id` (for external crew), client `punch_id`, `device_time` and `monotonic_offset_ms`, and the location with its `geofence_id`. The worker is always the caller; `timeEntries.clockOut` closes the caller's open entry with an Out punch.",
      reason:
        "Clocking goes through app.record_punch (0941): it opens or closes the signed-in worker's own entry exactly once per client punch id, counts the device time within the skew tolerance and checks the geofence. The frozen body named another person, the old column names and no project, which the punch path cannot take.",
      apply: (spec) =>
        putActions([
          {
            ...(spec.actions.find((a) => a.verb === "clockIn") as ActionSpec),
            body: z
              .object({
                project_id: fields.ref("project the caller clocks in on"),
                shift_id: orNull(fields.ref("Accepted shift of the caller")).optional(),
                engagement_id: orNull(
                  fields.ref("caller's open engagement, when they work as external crew"),
                ).optional(),
                punch_id: fields
                  .uuid("Client punch id; a replay with the same id returns the same entry.")
                  .optional(),
                device_time: fields
                  .instant("When the punch was made on the device; defaults to now.")
                  .optional(),
                monotonic_offset_ms: z
                  .int()
                  .min(0)
                  .meta({
                    description:
                      "Milliseconds since the punch on the device's monotonic clock, for a punch queued offline.",
                    example: 0,
                    format: "int64",
                  })
                  .optional(),
                latitude: orNull(fields.latitude()).optional(),
                longitude: orNull(fields.longitude()).optional(),
                accuracy_m: orNull(
                  z
                    .number()
                    .min(0)
                    .meta({ description: "Location accuracy in metres.", example: 12 }),
                ).optional(),
                geofence_id: orNull(
                  fields.ref("geofence the location is checked against"),
                ).optional(),
              })
              .meta({
                id: "TimeEntryClockInRequest",
                description: "The punch that opens the caller's time entry.",
              }),
          },
        ])(spec),
    },
    {
      id: "time-entry-correction-proposed-times",
      since: SINCE,
      resources: ["timeEntryCorrections"],
      change:
        "The proposed times are `proposed_clock_in` (required), `proposed_clock_out` and `proposed_break_minutes`; adds `requested_by`; removes `clock_in_at` and `clock_out_at`. `correction_state` is Proposed, Approved or Rejected.",
      reason:
        "app.time_entry_corrections (0340) proposes a whole window: `proposed_clock_in` is NOT NULL, the break defaults to 0, and the requester is stamped from the session.",
      apply: editShape({
        remove: ["clock_in_at", "clock_out_at"],
        add: {
          proposed_clock_in: { schema: fields.instant("Proposed clock in."), create: "required" },
          proposed_clock_out: {
            schema: orNull(fields.instant("Proposed clock out.")),
            create: "optional",
          },
          proposed_break_minutes: {
            schema: fields.int("Proposed unpaid break minutes.", 30),
            create: "optional",
          },
          requested_by: { schema: orNull(fields.ref("person who asked for the correction")) },
          correction_state: {
            schema: label(["Proposed", "Approved", "Rejected"], "Correction state."),
          },
        },
      }),
    },
    {
      id: "time-entry-audit-diffs",
      since: SINCE,
      resources: ["timeEntryAuditEntries"],
      change:
        "An audit row carries `old_values` and `new_values` (the changed columns); removes `field`, `from_value`, `to_value` and `changed_at` (the row's `created_at` is the change time).",
      reason:
        "app.time_entry_audit (0340) writes one row per change with the before and after values of every changed column as JSON (ADR 0002 allows JSON for audit diffs), stamped by `created_at`.",
      apply: editShape({
        remove: ["field", "from_value", "to_value", "changed_at"],
        add: {
          old_values: {
            schema: orNull(fields.document("Changed columns before the change; null on insert.")),
          },
          new_values: { schema: fields.document("Changed columns after the change.") },
        },
      }),
    },
    {
      id: "timesheet-project-period",
      since: SINCE,
      resources: ["timesheets"],
      change:
        "A timesheet is one worker (`membership_id` or `engagement_id`) on a required `project_id` for `period_start` to `period_end`; adds `submitted_by`; removes `person_id`, `pay_period_id` and `total_hours`. `timesheet_state` is Proposed, Submitted, Approved or Rejected.",
      reason:
        "app.timesheets (0340, 0940) is keyed by project, worker and period dates, not a pay period; hours are derived from the time entries by the view app.timesheet_hours and are not a column. The submitter is stamped by app.submit_timesheet.",
      apply: editShape({
        remove: ["person_id", "pay_period_id", "total_hours"],
        add: {
          project_id: { schema: fields.ref("project worked"), create: "required" },
          membership_id: { schema: membership("the person who worked"), create: "optional" },
          engagement_id: { schema: engagement("the person who worked"), create: "optional" },
          period_start: { schema: fields.date("First day of the period."), create: "required" },
          period_end: { schema: fields.date("Last day of the period."), create: "required" },
          submitted_by: { schema: orNull(fields.ref("person who submitted the timesheet")) },
          timesheet_state: {
            schema: label(["Proposed", "Submitted", "Approved", "Rejected"], "Timesheet state."),
          },
        },
      }),
    },
    {
      id: "timesheet-approval-minutes",
      since: SINCE,
      resources: ["timesheetApprovals"],
      change:
        "An approval is `approved_by` with `approved_minutes` and `voided_at`; removes `approver_id`, `decision`, `decided_at` and `voided`.",
      reason:
        "app.timesheet_approvals (0340) holds only approvals (a rejection is a timesheet state), records the minutes approved so a later hours change can void it, and stamps `voided_at` instead of a flag; `created_at` is the decision time.",
      apply: editShape({
        remove: ["approver_id", "decision", "decided_at", "voided"],
        add: {
          approved_by: { schema: fields.ref("approver") },
          approved_minutes: { schema: fields.int("Minutes approved.", 2490) },
          voided_at: {
            schema: orNull(fields.instant("When an hours change voided the approval.")),
          },
        },
      }),
    },
    {
      id: "kiosk-device-project",
      since: SINCE,
      resources: ["kioskDevices"],
      change:
        "A kiosk serves an optional `project_id` and reports `last_seen_at` and `revoked_at`; removes `venue_id` and `active`. Adds `device_key`, present only in the create response.",
      reason:
        "app.kiosk_devices (0340) belongs to a project, not a venue, and is retired by stamping `revoked_at` or deleting it. Its device key is issued once by app.register_kiosk_device and stored only as a hash that callers never read, so the create response is the one place the key can be handed over.",
      apply: editShape({
        remove: ["venue_id", "active"],
        add: {
          project_id: {
            schema: orNull(fields.ref("project the kiosk serves")),
            create: "optional",
          },
          device_key: {
            schema: orNull(
              z
                .string()
                .regex(/^xkio_[0-9a-f]{64}$/)
                .meta({
                  description:
                    "Device key the kiosk signs in with. Returned once, in the create response; null on every read, because only its hash is kept (invariant 8).",
                  example: "xkio_9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b",
                }),
            ),
          },
          last_seen_at: { schema: orNull(fields.instant("Last time the kiosk checked in.")) },
          revoked_at: {
            schema: orNull(fields.instant("When the kiosk was revoked; it accepts no punches.")),
          },
        },
      }),
    },
    {
      id: "rate-card-currency-code",
      since: SINCE,
      resources: ["rateCards"],
      change: "`currency` becomes `currency_code`.",
      reason: "app.rate_cards (0341) names the column `currency_code`.",
      apply: editShape({ rename: { currency: "currency_code" } }),
    },
    {
      id: "rate-card-line-canon-combination",
      since: SINCE,
      resources: ["rateCardLines"],
      change:
        "A line prices a canon combination: `worker_classification`, `pay_basis` and `arrangement` (required) with a required canon `overtime_rule_id`; adds `canon_rate_card_id`. Removes `rate_type` and `currency` (the rate is in the card's currency). `rate_minor` stays nullable (unpriced) and Restricted.",
      reason:
        "app.rate_card_lines (0341) keys a line by role, worker classification, pay basis and arrangement (a permitted xpms pair, decision D16) and names an xpms.overtime_rule (decision D14); the currency is app.rate_cards.currency_code.",
      apply: editShape({
        remove: ["rate_type", "currency"],
        add: {
          worker_classification: {
            schema: fields.code(
              "Worker classification priced, from xpms.worker_classification.",
              "EMPLOYEE",
            ),
            create: "required",
          },
          pay_basis: {
            schema: fields.text("Pay basis; with the classification a permitted pair.", "Hourly"),
            create: "required",
          },
          arrangement: {
            schema: fields.text(
              "Arrangement; with the classification a permitted pair.",
              "Per Engagement",
            ),
            create: "required",
          },
          overtime_rule_id: {
            schema: fields.code("Canon overtime rule whose multipliers apply.", "OTR-001"),
            create: "required",
          },
          canon_rate_card_id: {
            schema: orNull(fields.code("Canon rate card the line was adopted from.", "LRC-001")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "pay-rate-membership",
      since: SINCE,
      resources: ["payRates"],
      change:
        "A pay rate belongs to a required `membership_id` with a required `role_code`, a required `rate_minor` (per hour) and `currency_code`; removes `person_id`, `rate_type` and `currency`.",
      reason:
        "app.pay_rates (0341) is an append-only ledger per membership and role; `role_code`, `rate_minor` (per hour) and `currency_code` are NOT NULL.",
      apply: editShape({
        remove: ["person_id", "rate_type", "currency"],
        add: {
          membership_id: {
            schema: fields.ref("membership of the person paid"),
            create: "required",
          },
          role_code: { schema: canonCodes.RoleCode, create: "required" },
          rate_minor: {
            schema: maskable(fields.money("Pay rate per hour.", 5200)),
            writeSchema: minor("Pay rate per hour.", 5200),
            create: "required",
          },
          currency_code: {
            schema: fields.currency("ISO 4217 currency of the rate."),
            create: "required",
          },
        },
      }),
    },
    {
      id: "overtime-rules-from-canon",
      since: SINCE,
      resources: ["overtimeRules"],
      change:
        "Overtime rules are read from canon `xpms.wage_hour_rule`, keyed by `jurisdiction_id`: `source`, `weekly_ot_after_hours`, `daily_ot_after_hours`, `daily_dt_after_hours`, `min_ot_multiplier` and `min_dt_multiplier`. Removes `name`, `threshold_hours`, `multiplier`, `period` and the tenant columns, and removes create, update and delete.",
      reason:
        "There is no app.overtime_rules table: overtime comes from canon (decision D14). xpms.wage_hour_rule (0101) holds each jurisdiction's daily and weekly thresholds and minimum multipliers, which app.calculate_payroll_run (0461) applies; orgs do not write canon.",
      apply: all(
        setTable("xpms.wage_hour_rule"),
        removeVerbs("create", "update", "delete"),
        editShape({
          remove: [
            "id",
            "org_id",
            "created_at",
            "created_by",
            "updated_at",
            "updated_by",
            "name",
            "threshold_hours",
            "multiplier",
            "period",
          ],
          key: "jurisdiction_id",
          description:
            "A jurisdiction's wage and hour rule from canon: daily and weekly overtime thresholds and minimum multipliers. A lower jurisdiction inherits its parent's rule.",
          add: {
            source: {
              schema: fields.text(
                "Statute or source of the rule.",
                "Fair Labor Standards Act, 29 U.S.C. 207",
              ),
            },
            weekly_ot_after_hours: {
              schema: orNull(fields.quantity("Weekly hours after which overtime applies.", 40)),
            },
            daily_ot_after_hours: {
              schema: orNull(fields.quantity("Daily hours after which overtime applies.", 8)),
            },
            daily_dt_after_hours: {
              schema: orNull(fields.quantity("Daily hours after which double time applies.", 12)),
            },
            min_ot_multiplier: {
              schema: orNull(fields.quantity("Minimum overtime multiplier.", 1.5)),
            },
            min_dt_multiplier: {
              schema: orNull(fields.quantity("Minimum double time multiplier.", 2)),
            },
          },
        }),
      ),
    },
    {
      id: "union-local-rate-columns",
      since: SINCE,
      resources: ["unionLocalRates"],
      change:
        "`currency` becomes `currency_code`; `rate_minor` is required; adds `fringe_minor` and `effective_to`.",
      reason:
        "app.union_local_rates (0341) names the column `currency_code`, stores the scale rate NOT NULL, and carries a nullable fringe amount and end date.",
      apply: editShape({
        rename: { currency: "currency_code" },
        add: {
          rate_minor: {
            schema: maskable(fields.money("Scale rate per hour.", 5600)),
            writeSchema: minor("Scale rate per hour.", 5600),
            create: "required",
          },
          fringe_minor: {
            schema: fields.money("Fringe per hour.", 1200),
            create: "optional",
          },
          effective_to: {
            schema: orNull(fields.date("Last day the rate applies.")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "wage-determination-minimum",
      since: SINCE,
      resources: ["wageDeterminations"],
      change:
        "A determination is a required `minimum_rate_minor` in `currency_code` from `effective_from` to `effective_to`, citing its `source`; removes `reference`, `rate_minor` and `currency`.",
      reason:
        "app.wage_determinations (0341) stores the prevailing minimum per hour (NOT NULL), its currency, validity dates and source citation.",
      apply: editShape({
        remove: ["reference", "rate_minor", "currency"],
        add: {
          minimum_rate_minor: {
            schema: fields.money("Prevailing minimum rate per hour.", 4800),
            writeSchema: minor("Prevailing minimum rate per hour.", 4800),
            create: "required",
          },
          currency_code: { schema: fields.currency("ISO 4217 currency."), create: "required" },
          effective_from: {
            schema: fields.date("First day the determination applies."),
            create: "required",
          },
          effective_to: {
            schema: orNull(fields.date("Last day the determination applies.")),
            create: "optional",
          },
          source: {
            schema: fields.text("Determination source or reference.", "FL20260001"),
            create: "required",
          },
        },
      }),
    },
    {
      id: "payroll-run-currency-and-calculation",
      since: SINCE,
      resources: ["payrollRuns"],
      change:
        "`currency` becomes `currency_code`; removes `gross_total` (totals are read from the run's lines). `payroll_run_state` is Draft, Calculated, Approved, Exported, Accepted or Canceled and the transition example becomes Exported to Accepted. Adds `payrollRuns.calculate` and `payrollRuns.approve`.",
      reason:
        "app.payroll_runs (0341) names the column `currency_code` and stores no total; app.payroll_line_amounts derives amounts. app.calculate_payroll_run (0461) builds the lines from approved member timesheets with canon overtime, and app.approve_payroll_run (0341) approves under spend authority, never by the creator.",
      apply: all(
        editShape({
          rename: { currency: "currency_code" },
          remove: ["gross_total"],
          add: {
            payroll_run_state: {
              schema: label(
                ["Draft", "Calculated", "Approved", "Exported", "Accepted", "Canceled"],
                "Payroll run state.",
              ),
            },
          },
        }),
        putActions(
          [
            transition("Payroll Run", ["Exported", "Accepted"]),
            itemAction("calculate", {
              summary: "Calculate a payroll run",
              description:
                "Replaces the run's lines from the approved member timesheets of its pay period, splitting overtime by the canon wage and hour rule of each project's jurisdiction; the run becomes Calculated. A missing earning code, rate or rule is refused (422) and names it.",
            }),
            itemAction("approve", {
              summary: "Approve a payroll run",
              description:
                "Records an approval on a Calculated run under spend authority for Payroll Run, never by the run's creator; the run becomes Approved once fully approved. A refusal returns 422 and names the rule.",
            }),
          ],
          { calculate: "crew.pay_period.manage", approve: "crew.pay_period.manage" },
        ),
      ),
    },
    {
      id: "payroll-line-membership-amounts",
      since: SINCE,
      resources: ["payrollLines"],
      change:
        "Lines are read from `app.payroll_line_amounts`: the worker is `membership_id`, with `rate_minor` and the derived `amount_minor` (both Restricted), `role_code` and `cost_center_id`; removes `person_id`, `currency` (the run's `currency_code` applies) and the audit columns, which the view does not carry (lines are written only by the calculation).",
      reason:
        "app.payroll_lines (0341) stores the membership, hours and rate; the view app.payroll_line_amounts derives the amount and masks both money columns for callers without data.restricted.read.payroll. The currency is the run's.",
      apply: all(
        setTable("app.payroll_line_amounts"),
        editShape({
          remove: ["person_id", "currency", "created_at", "created_by", "updated_at", "updated_by"],
          add: {
            membership_id: { schema: fields.ref("membership of the person paid") },
            rate_minor: { schema: maskable(fields.money("Rate paid per hour.", 5200)) },
            role_code: { schema: orNull(canonCodes.RoleCode) },
            cost_center_id: { schema: orNull(fields.ref("cost center charged")) },
          },
        }),
        restrict("rate_minor", "amount_minor"),
      ),
    },
    {
      id: "payroll-export-file",
      since: SINCE,
      resources: ["payrollExports"],
      change:
        "An export records its `file_uri` and `checksum_sha256`; removes `export_state` and `document_id`. Create produces the file from an Approved run, moves the run to Exported and needs the Team plan, data.export.restricted and a second factor.",
      reason:
        "app.payroll_exports (0341) is an append-only record of each produced file with its location and SHA-256; app.produce_payroll_export (0461) renders the file deterministically, checks the payroll_export plan feature in SQL, and needs crew.payroll.export, data.export.restricted and aal2.",
      apply: editShape({
        remove: ["export_state", "document_id"],
        add: {
          file_uri: {
            schema: fields.text(
              "Logical location of the export file.",
              "payroll-exports/0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f.csv",
              1000,
            ),
          },
          checksum_sha256: {
            schema: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .meta({
                description: "SHA-256 of the export file, lowercase hex.",
                example: "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b",
              }),
          },
        },
      }),
    },
    {
      id: "earning-code-columns",
      since: SINCE,
      resources: ["earningCodes"],
      change:
        "`earning_code` becomes `code` and `overtime` becomes `is_overtime`, which is optional on create (default false).",
      reason:
        "app.earning_codes (0341) names the columns `code` and `is_overtime` and defaults `is_overtime` to false.",
      apply: editShape({
        rename: { earning_code: "code", overtime: "is_overtime" },
        optionalOnCreate: ["is_overtime"],
      }),
    },
    {
      id: "per-diem-daily-rows",
      since: SINCE,
      resources: ["perDiems"],
      change:
        "A per diem is one `day` on a required `project_id` for a worker (`membership_id` or `engagement_id`), with a required `amount_minor` and `currency_code`; removes `daily_amount_minor`, `currency`, `starts_on` and `ends_on`. `engagement_id` becomes nullable, and the amount is not Restricted.",
      reason:
        "app.per_diems (0341, 0981) stores one row per worker, project and day (unique), names the worker by membership or engagement, and keeps the amount NOT NULL in an unmasked column.",
      apply: all(
        editShape({
          remove: ["daily_amount_minor", "currency", "starts_on", "ends_on"],
          nullable: ["engagement_id"],
          add: {
            project_id: { schema: fields.ref("project worked"), create: "required" },
            membership_id: { schema: membership("the person paid"), create: "optional" },
            day: { schema: fields.date("Day the allowance covers."), create: "required" },
            amount_minor: {
              schema: fields.money("Allowance for the day.", 6500),
              writeSchema: minor("Allowance for the day.", 6500),
              create: "required",
            },
            currency_code: { schema: fields.currency("ISO 4217 currency."), create: "required" },
          },
        }),
        restrict(),
      ),
    },
    {
      id: "time-off-policy-accrual-nullable",
      since: SINCE,
      resources: ["timeOffPolicies"],
      change: "`accrual_hours_per_period` becomes nullable.",
      reason:
        "app.time_off_policies (0341) leaves `accrual_hours_per_period` NULL for a policy that does not accrue.",
      apply: editShape({ nullable: ["accrual_hours_per_period"] }),
    },
    {
      id: "time-off-request-membership-hours",
      since: SINCE,
      resources: ["timeOffRequests"],
      change:
        "The requester is a required `membership_id`; adds a required `hours`; removes `person_id`. `time_off_state` is Proposed, Approved, Rejected or Canceled.",
      reason:
        "app.time_off_requests (0341) names the requester by membership and stores the hours requested (NOT NULL).",
      apply: editShape({
        remove: ["person_id"],
        add: {
          membership_id: {
            schema: fields.ref("membership of the person requesting"),
            create: "required",
            update: false,
          },
          hours: { schema: fields.quantity("Hours requested.", 16), create: "required" },
          time_off_state: {
            schema: label(["Proposed", "Approved", "Rejected", "Canceled"], "Request state."),
          },
        },
      }),
    },
    ...crewFieldHomes,
    ...crewFieldExposure,
    // Last, so the result carries every field the corrections above give the shift.
    {
      id: "shift-claim-waiting",
      since: SINCE,
      resources: ["shifts"],
      change:
        "`shifts.claim` returns ShiftClaimResult: the shift and `claim`, the caller's claim that waits for a supervisor, or null when the caller got the shift. The response keeps the shift's `ETag`.",
      reason:
        "Under the project's claiming rule (scheduling.open_shift_claiming, 1322) app.claim_open_shift gives the shift only under first-come. Under approval, the default, or seniority it records a claim in app.shift_claims and returns its id, and the shift stays Published with no one on it.",
      apply: (spec: ResourceSpec) =>
        putActions([
          itemAction("claim", {
            summary: "Claim an open shift",
            description:
              "Claims a published shift that has no one on it for the caller's own membership, under the project's claiming rule (scheduling.open_shift_claiming). Under first-come the caller gets the shift at once: it becomes Accepted and `claim` is null. Under approval, the default, or seniority the claim waits for a supervisor: the shift stays Published with no one on it and `claim` carries the waiting claim. A second claim on the shift while the caller's first one waits is refused (422, shift_claim_waiting). A held, unpublished or overlapping shift is refused (422).",
            response: shiftClaimResult(spec.def.read),
            etag: true,
          }),
        ])(spec),
    },
  ],
});
