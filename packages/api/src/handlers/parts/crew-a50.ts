/**
 * Crew handlers added by A50 (gate 5, RRR-94), beside A13's pay periods, rate cards, earning codes
 * and time off policies in handlers/crew.ts, which spreads them. Every resource reads and writes as
 * the caller in the shape corrected in catalog/modules/crew.ts (ADR 0023), so row level security,
 * the column grants and the guards decide every refusal (422 with the rule):
 *   - shifts move through app.transition_shift, app.accept_shift and app.claim_open_shift;
 *   - swaps are asked by the person on the shift and decided by someone else (decide_shift_swap);
 *   - clocking in and out is a punch (app.record_punch, 0941): always the caller's own entry, once
 *     per client punch id;
 *   - corrections, timesheets and time off are decided through their RPCs, never by the requester;
 *   - payroll runs are calculated, approved under spend authority and exported through 0341 and 0461;
 *   - Restricted rates are read from the masked views (Section 8.3) and answer `{ masked: true }`
 *     to a caller without data.restricted.read.payroll.
 */
import {
  acceptShift,
  approvePayrollRun,
  calculatePayrollRun,
  cancelSwap,
  claimOpenShift,
  decideCorrection,
  decideSwap,
  decideTimeOff,
  decideTimesheet,
  producePayrollExport,
  submitTimesheet,
  transitionPayrollRun,
  transitionShift,
  type PayrollRunState,
  type ShiftState,
} from "@xos/data/crew";
import { conflict, notFound, refused } from "../../problem.ts";
import { requireOrg } from "../../runtime/context.ts";
import type { RequestContext } from "../../runtime/context.ts";
import type { ErasedHandler } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { masked } from "../../runtime/masking.ts";
import { mergeBy } from "../support/enrich.ts";
import {
  from,
  groupBy,
  keysOf,
  rpc,
  run,
  tableResource,
  unwrap,
  type Row,
} from "../support/table.ts";

const PAYROLL_REASON = "Requires data.restricted.read.payroll.";

/** The Restricted rate of a row from its masked view, as the contract shows it. */
async function maskedRate(context: RequestContext, view: string, id: unknown): Promise<unknown> {
  const row = await run<{ rate_minor: number | null; is_masked: boolean } | null>(
    from(context.db, view).select("rate_minor, is_masked").eq("id", id).maybeSingle(),
  );
  if (row === null || row.is_masked) return masked(PAYROLL_REASON);
  return row.rate_minor;
}

function expectState(current: Row, column: string, expected: unknown, label: string): void {
  if (current[column] !== expected) {
    throw conflict(
      `The ${label} is ${String(current[column])}, not ${String(expected)}; read it again before changing it.`,
    );
  }
}

const body = (request: { body?: unknown }) => (request.body ?? {}) as Row;

// Resources ---------------------------------------------------------------------------------------

const shifts = tableResource("shifts");
const shiftSwaps = tableResource("shiftSwaps", { verbs: ["list", "get"] });
const timeEntries = tableResource("timeEntries", {
  verbs: ["list", "get"],
  derived: ["meal_out_at", "meal_in_at"],
  // The meal break: the entry's first Break Start and last Break End punches (A54-002).
  enrich: async (rows, { db }) =>
    mergeBy(
      rows,
      "id",
      await groupBy(
        from(db, "clock_punches")
          .select("time_entry_id, punch_kind, effective_at")
          .in("time_entry_id", keysOf(rows, "id"))
          .in("punch_kind", ["Break Start", "Break End"])
          .is("deleted_at", null)
          .order("effective_at", { ascending: true }),
        "time_entry_id",
      ),
      (punches) => ({
        meal_out_at:
          punches.find((p) => p["punch_kind"] === "Break Start")?.["effective_at"] ?? null,
        meal_in_at:
          punches.filter((p) => p["punch_kind"] === "Break End").pop()?.["effective_at"] ?? null,
      }),
    ),
});
const timeEntryCorrections = tableResource("timeEntryCorrections");
const timeEntryAudit = tableResource("timeEntryAuditEntries");
const timesheets = tableResource("timesheets");
const timesheetApprovals = tableResource("timesheetApprovals");
// The device key is shown once, in the create response; reads never carry it.
const kioskDevices = tableResource("kioskDevices", {
  verbs: ["list", "get", "update", "delete"],
  derived: ["device_key"],
});
const rateCardLines = tableResource("rateCardLines", {
  derived: ["rate_minor"],
  toContract: async (row, context) => ({
    ...row,
    rate_minor: await maskedRate(context, "rate_card_lines_masked", row["id"]),
  }),
});
const payRates = tableResource("payRates", {
  derived: ["rate_minor"],
  toContract: async (row, context) => ({
    ...row,
    rate_minor: await maskedRate(context, "pay_rates_masked", row["id"]),
  }),
});
const overtimeRules = tableResource("overtimeRules", { softDelete: false });
const unionLocalRates = tableResource("unionLocalRates");
const wageDeterminations = tableResource("wageDeterminations");
const payrollRuns = tableResource("payrollRuns");
// The view filters deleted lines itself and masks rate and amount.
const payrollLines = tableResource("payrollLines", {
  softDelete: false,
  extraColumns: ["is_masked"],
  toContract: (row) =>
    row["is_masked"] === true
      ? { ...row, rate_minor: masked(PAYROLL_REASON), amount_minor: masked(PAYROLL_REASON) }
      : row,
});
const payrollExports = tableResource("payrollExports", { verbs: ["list", "get"] });
const perDiems = tableResource("perDiems");
const timeOffRequests = tableResource("timeOffRequests");

export const crewA50Handlers: Readonly<Record<string, ErasedHandler>> = {
  // Shifts --------------------------------------------------------------------------------------
  ...shifts.handlers,
  "shifts.transition": async (request, context) => {
    const input = body(request);
    const current = await shifts.read(context, String(request.params["id"]), ["id", "shift_state"]);
    expectState(current, "shift_state", input["expected_state"], "shift");
    unwrap(
      await transitionShift(
        context.db,
        String(request.params["id"]),
        input["expected_state"] as ShiftState,
        input["to_state"] as ShiftState,
        typeof input["reason"] === "string"
          ? input["reason"]
          : `Moved to ${String(input["to_state"])}.`,
      ),
    );
    return ok(await shifts.read(context, String(request.params["id"])));
  },
  "shifts.accept": async (request, context) => {
    const id = String(request.params["id"]);
    await shifts.read(context, id, ["id"]);
    unwrap(await acceptShift(context.db, id, "Accepted."));
    return ok(await shifts.read(context, id));
  },
  // Under first-come the caller gets the shift; under approval or seniority (1322) the shift stays
  // Published and the response carries the claim that waits for a supervisor.
  "shifts.claim": async (request, context) => {
    const id = String(request.params["id"]);
    await shifts.read(context, id, ["id"]);
    const outcome = unwrap(await claimOpenShift(context.db, id, "Claimed an open shift."));
    return ok({
      ...(await shifts.read(context, id)),
      claim: outcome.kind === "waiting" ? { id: outcome.claimId, claim_state: "Requested" } : null,
    });
  },

  // Swaps: the person on the shift asks; the party and project come from the shift ------------------
  ...shiftSwaps.handlers,
  "shiftSwaps.create": async (request, context) => {
    const input = body(request);
    const shift = await shifts.read(context, String(input["shift_id"]), [
      "id",
      "project_id",
      "membership_id",
    ]);
    if (shift["membership_id"] === null) {
      throw refused("REFUSE", "Only a shift with someone on it can be swapped.", "swap_open_shift");
    }
    const inserted = await run<{ id: string }>(
      from(context.db, "shift_swaps")
        .insert({
          org_id: requireOrg(context).id,
          project_id: shift["project_id"],
          shift_id: shift["id"],
          requested_by_membership_id: shift["membership_id"],
          proposed_membership_id: input["proposed_membership_id"],
        })
        .select("id")
        .single(),
    );
    return created(await shiftSwaps.read(context, inserted.id));
  },
  "shiftSwaps.approve": async (request, context) => {
    const id = String(request.params["id"]);
    await shiftSwaps.read(context, id, ["id"]);
    unwrap(await decideSwap(context.db, id, "Approved", "Approved."));
    return ok(await shiftSwaps.read(context, id));
  },
  "shiftSwaps.decline": async (request, context) => {
    const id = String(request.params["id"]);
    await shiftSwaps.read(context, id, ["id"]);
    unwrap(await decideSwap(context.db, id, "Rejected", "Declined."));
    return ok(await shiftSwaps.read(context, id));
  },
  "shiftSwaps.withdraw": async (request, context) => {
    const id = String(request.params["id"]);
    await shiftSwaps.read(context, id, ["id"]);
    unwrap(await cancelSwap(context.db, id, "Withdrawn by the requester."));
    return ok(await shiftSwaps.read(context, id));
  },

  // Time entries: punches through app.record_punch -------------------------------------------------
  ...timeEntries.handlers,
  "timeEntries.clockIn": async (request, context) => {
    const input = body(request);
    const punch = await run<{ time_entry_id: string }>(
      rpc(context.db, "record_punch", {
        p_punch_id: input["punch_id"] ?? crypto.randomUUID(),
        p_project_id: input["project_id"],
        p_punch_kind: "In",
        p_device_time: input["device_time"] ?? new Date().toISOString(),
        p_monotonic_offset_ms: input["monotonic_offset_ms"] ?? null,
        p_shift_id: input["shift_id"] ?? null,
        p_latitude: input["latitude"] ?? null,
        p_longitude: input["longitude"] ?? null,
        p_accuracy_m: input["accuracy_m"] ?? null,
        p_geofence_id: input["geofence_id"] ?? null,
        p_source: "Mobile",
        p_engagement_id: input["engagement_id"] ?? null,
      }),
    );
    return created(await timeEntries.read(context, punch.time_entry_id));
  },
  "timeEntries.clockOut": async (request, context) => {
    const id = String(request.params["id"]);
    const entry = await timeEntries.read(context, id, [
      "id",
      "project_id",
      "engagement_id",
      "clock_out",
    ]);
    if (entry["clock_out"] !== null) {
      throw refused("REFUSE", "This time entry is already clocked out.", "punch_not_in");
    }
    const punch = await run<{ time_entry_id: string }>(
      rpc(context.db, "record_punch", {
        p_punch_id: crypto.randomUUID(),
        p_project_id: entry["project_id"],
        p_punch_kind: "Out",
        p_device_time: new Date().toISOString(),
        p_source: "Mobile",
        p_engagement_id: entry["engagement_id"] ?? null,
      }),
    );
    if (punch.time_entry_id !== id) {
      throw refused("REFUSE", "Your open time entry is another one.", "punch_other_entry");
    }
    return ok(await timeEntries.read(context, id));
  },

  // Corrections, audit, timesheets and approvals ----------------------------------------------------
  ...timeEntryCorrections.handlers,
  "timeEntryCorrections.approve": async (request, context) => {
    const id = String(request.params["id"]);
    await timeEntryCorrections.read(context, id, ["id"]);
    unwrap(await decideCorrection(context.db, id, "Approved", "Approved."));
    return ok(await timeEntryCorrections.read(context, id));
  },
  ...timeEntryAudit.handlers,
  ...timesheets.handlers,
  "timesheets.submit": async (request, context) => {
    const id = String(request.params["id"]);
    await timesheets.read(context, id, ["id"]);
    unwrap(await submitTimesheet(context.db, id, "Submitted for approval."));
    return ok(await timesheets.read(context, id));
  },
  "timesheets.approve": async (request, context) => {
    const id = String(request.params["id"]);
    await timesheets.read(context, id, ["id"]);
    unwrap(await decideTimesheet(context.db, id, "Approved", "Approved."));
    return ok(await timesheets.read(context, id));
  },
  ...timesheetApprovals.handlers,

  // Kiosks: registered through app.register_kiosk_device, which returns the key once -------------------
  ...kioskDevices.handlers,
  "kioskDevices.create": async (request, context) => {
    const input = body(request);
    const rows = await run<{ kiosk_device_id: string; device_key: string }[]>(
      rpc(context.db, "register_kiosk_device", {
        p_org_id: requireOrg(context).id,
        p_name: input["name"],
        p_project_id: input["project_id"] ?? null,
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("register_kiosk_device returned no row.");
    const device = await kioskDevices.read(context, row.kiosk_device_id);
    return created({ ...device, device_key: row.device_key });
  },

  // Rates ------------------------------------------------------------------------------------------
  ...rateCardLines.handlers,
  ...payRates.handlers,
  ...overtimeRules.handlers,
  ...unionLocalRates.handlers,
  ...wageDeterminations.handlers,

  // Payroll ----------------------------------------------------------------------------------------
  ...payrollRuns.handlers,
  "payrollRuns.transition": async (request, context) => {
    const input = body(request);
    const id = String(request.params["id"]);
    const current = await payrollRuns.read(context, id, ["id", "payroll_run_state"]);
    expectState(current, "payroll_run_state", input["expected_state"], "payroll run");
    unwrap(
      await transitionPayrollRun(
        context.db,
        id,
        input["expected_state"] as PayrollRunState,
        input["to_state"] as PayrollRunState,
        typeof input["reason"] === "string"
          ? input["reason"]
          : `Moved to ${String(input["to_state"])}.`,
      ),
    );
    return ok(await payrollRuns.read(context, id));
  },
  "payrollRuns.calculate": async (request, context) => {
    const id = String(request.params["id"]);
    await payrollRuns.read(context, id, ["id"]);
    unwrap(await calculatePayrollRun(context.db, id, "Calculated from approved timesheets."));
    return ok(await payrollRuns.read(context, id));
  },
  "payrollRuns.approve": async (request, context) => {
    const id = String(request.params["id"]);
    await payrollRuns.read(context, id, ["id"]);
    unwrap(await approvePayrollRun(context.db, id, "Approved."));
    return ok(await payrollRuns.read(context, id));
  },
  ...payrollLines.handlers,
  ...payrollExports.handlers,
  "payrollExports.create": async (request, context) => {
    const input = body(request);
    await payrollRuns.read(context, String(input["payroll_run_id"]), ["id"]);
    const file = unwrap(
      await producePayrollExport(
        context.db,
        String(input["payroll_run_id"]),
        String(input["provider"]),
      ),
    );
    if (file.exportId === null)
      throw notFound("The export was produced but is not visible to you.");
    return created(await payrollExports.read(context, file.exportId));
  },

  // Per diems and time off ----------------------------------------------------------------------------
  ...perDiems.handlers,
  ...timeOffRequests.handlers,
  "timeOffRequests.approve": async (request, context) => {
    const id = String(request.params["id"]);
    await timeOffRequests.read(context, id, ["id"]);
    unwrap(await decideTimeOff(context.db, id, "Approved", "Approved."));
    return ok(await timeOffRequests.read(context, id));
  },
  "timeOffRequests.decline": async (request, context) => {
    const id = String(request.params["id"]);
    await timeOffRequests.read(context, id, ["id"]);
    unwrap(await decideTimeOff(context.db, id, "Rejected", "Declined."));
    return ok(await timeOffRequests.read(context, id));
  },
};
