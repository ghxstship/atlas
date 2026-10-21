/**
 * Contract tests for A50's Crew handlers (Section 18, gate 5, RRR-94): shifts, swaps, punches,
 * corrections, timesheets, kiosks, rates, payroll, per diems and time off. Requests run through
 * `contractApp` against the in-memory client; every success is checked against openapi/v1.json
 * with `expectContract`. RPCs are stand-ins that refuse the way the database does (XR001 with the
 * rule), so compare-and-set conflicts (409), refusals (422) and hidden rows (404) are covered.
 */
import { describe, expect, it } from "vitest";
import { handlers as crew } from "../src/handlers/crew.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(51000 + n).padStart(12, "0")}`;
const MISSING = id(9999);

const PROJECT = id(1);
const MEMBER = id(2);
const OTHER_MEMBER = id(3);
const SHIFT = id(10);
const OPEN_SHIFT = id(11);
/** An open shift on a project whose claiming rule is approval (scheduling.open_shift_claiming, 1322). */
const WAITING_SHIFT = id(12);
const APPROVAL_PROJECT = id(5);
const CLAIM = id(13);
const SWAP = id(20);
const ENTRY = id(30);
const CORRECTION = id(40);
const AUDIT = id(41);
const SHEET = id(50);
const APPROVAL = id(51);
const KIOSK = id(60);
const CARD = id(70);
const LINE = id(71);
const PAY_RATE = id(72);
const UNION = id(73);
const WAGE = id(74);
const PERIOD = id(80);
const RUN = id(81);
const PAYROLL_LINE = id(82);
const EXPORT = id(83);
const PER_DIEM = id(90);
const POLICY = id(91);
const TIME_OFF = id(92);
const SHA = "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b";

/** A stored row: the contract sample with the tenant columns of the table. */
const row = (component: string, key: string, extra: Row = {}): Row => {
  const base = sample(component);
  return tenantRow(key, ORG, { ...base, ...extra, id: key, org_id: ORG });
};

function find(db: MemoryDb, table: string, key: unknown): Row {
  return db.tables[table]?.find((r) => r["id"] === key) as Row;
}

/** A lifecycle stand-in: compare-and-set on the expected state. */
function moves(table: string, column: string, keyArg: string) {
  return (args: Row, db: MemoryDb) => {
    const r = find(db, table, args[keyArg]);
    if (r[column] !== args["p_expected"]) throw refusal(`${table}_state_conflict`);
    if (args["p_next"] === "Canceled" && table === "payroll_runs") {
      throw refusal("payroll_run_exported");
    }
    r[column] = args["p_next"];
    return id(7000);
  };
}

/** A decision stand-in: Approved or Rejected sets the state; the requester is refused. */
function decides(
  table: string,
  column: string,
  keyArg: string,
  approved: string,
  rejected: string,
) {
  return (args: Row, db: MemoryDb) => {
    const r = find(db, table, args[keyArg]);
    if (r["requested_by"] === testContext().personId) throw refusal("sod_approval_requester");
    r[column] = args["p_decision"] === "Approved" ? approved : rejected;
    return id(7001);
  };
}

function world() {
  const db = memoryDb(
    {
      shifts: [
        row("Shift", SHIFT, {
          project_id: PROJECT,
          membership_id: MEMBER,
          engagement_id: null,
          shift_state: "Published",
        }),
        row("Shift", OPEN_SHIFT, {
          project_id: PROJECT,
          membership_id: null,
          engagement_id: null,
          shift_state: "Published",
        }),
        row("Shift", WAITING_SHIFT, {
          project_id: APPROVAL_PROJECT,
          membership_id: null,
          engagement_id: null,
          shift_state: "Published",
        }),
      ],
      shift_claims: [],
      shift_swaps: [
        row("ShiftSwap", SWAP, {
          shift_id: SHIFT,
          project_id: PROJECT,
          requested_by_membership_id: MEMBER,
          proposed_membership_id: OTHER_MEMBER,
          swap_state: "Proposed",
        }),
      ],
      time_entries: [
        row("TimeEntry", ENTRY, {
          project_id: PROJECT,
          membership_id: MEMBER,
          engagement_id: null,
          shift_id: SHIFT,
          kiosk_device_id: null,
          clock_out: null,
          auto_closed_at: null,
        }),
      ],
      time_entry_corrections: [
        row("TimeEntryCorrection", CORRECTION, {
          time_entry_id: ENTRY,
          correction_state: "Proposed",
          requested_by: id(4),
        }),
      ],
      time_entry_audit: [row("TimeEntryAudit", AUDIT, { time_entry_id: ENTRY, old_values: null })],
      timesheets: [
        row("Timesheet", SHEET, {
          project_id: PROJECT,
          membership_id: MEMBER,
          engagement_id: null,
          timesheet_state: "Proposed",
          submitted_by: null,
          requested_by: id(4),
        }),
      ],
      timesheet_approvals: [
        row("TimesheetApproval", APPROVAL, { timesheet_id: SHEET, voided_at: null }),
      ],
      kiosk_devices: [
        row("KioskDevice", KIOSK, { project_id: PROJECT, last_seen_at: null, revoked_at: null }),
      ],
      rate_card_lines: [
        row("RateCardLine", LINE, { rate_card_id: CARD, canon_rate_card_id: null }),
      ],
      rate_card_lines_masked: [{ id: LINE, rate_minor: null, is_masked: true }],
      pay_rates: [row("PayRate", PAY_RATE, { membership_id: MEMBER })],
      pay_rates_masked: [{ id: PAY_RATE, rate_minor: 5200, is_masked: false }],
      "xpms.wage_hour_rule": [sample("OvertimeRule")],
      union_local_rates: [row("UnionLocalRate", UNION, { effective_to: null })],
      wage_determinations: [row("WageDetermination", WAGE, { effective_to: null })],
      payroll_runs: [
        row("PayrollRun", RUN, {
          pay_period_id: PERIOD,
          payroll_run_state: "Draft",
          requested_by: id(4),
        }),
      ],
      payroll_line_amounts: [
        {
          ...sample("PayrollLine"),
          id: PAYROLL_LINE,
          org_id: ORG,
          payroll_run_id: RUN,
          rate_minor: null,
          amount_minor: null,
          is_masked: true,
        },
      ],
      payroll_exports: [
        row("PayrollExport", EXPORT, { payroll_run_id: RUN, checksum_sha256: SHA }),
      ],
      per_diems: [
        row("PerDiem", PER_DIEM, {
          project_id: PROJECT,
          membership_id: MEMBER,
          engagement_id: null,
        }),
      ],
      time_off_requests: [
        row("TimeOffRequest", TIME_OFF, {
          time_off_policy_id: POLICY,
          membership_id: MEMBER,
          time_off_state: "Proposed",
          requested_by: id(4),
        }),
      ],
    },
    {
      transition_shift: moves("shifts", "shift_state", "p_shift_id"),
      accept_shift: (args, db) => {
        find(db, "shifts", args["p_shift_id"])["shift_state"] = "Accepted";
        return id(7002);
      },
      claim_open_shift: (args, db) => {
        const s = find(db, "shifts", args["p_shift_id"]);
        if (s["membership_id"] !== null) throw refusal("shift_not_open");
        if (s["project_id"] === APPROVAL_PROJECT) {
          // Approval: the claim waits in app.shift_claims and the shift stays Published.
          const claims = db.tables["shift_claims"] as Row[];
          if (claims.some((c) => c["shift_id"] === s["id"] && c["claim_state"] === "Requested")) {
            throw refusal("shift_claim_waiting");
          }
          claims.push(
            tenantRow(CLAIM, ORG, {
              id: CLAIM,
              org_id: ORG,
              project_id: APPROVAL_PROJECT,
              shift_id: s["id"],
              membership_id: MEMBER,
              claim_state: "Requested",
            }),
          );
          return CLAIM;
        }
        Object.assign(s, { membership_id: MEMBER, shift_state: "Accepted" });
        return id(7003);
      },
      decide_shift_swap: (args, db) => {
        find(db, "shift_swaps", args["p_shift_swap_id"])["swap_state"] =
          args["p_decision"] === "Approved" ? "Approved" : "Rejected";
        return id(7004);
      },
      cancel_shift_swap: (args, db) => {
        find(db, "shift_swaps", args["p_shift_swap_id"])["swap_state"] = "Canceled";
        return id(7005);
      },
      record_punch: (args, db) => {
        const entries = db.tables["time_entries"] as Row[];
        const open = entries.find((e) => e["clock_out"] === null && e["deleted_at"] === null);
        if (args["p_punch_kind"] === "In") {
          if (open !== undefined) throw refusal("punch_already_in");
          const entry = row("TimeEntry", id(31), {
            project_id: args["p_project_id"],
            membership_id: MEMBER,
            engagement_id: null,
            shift_id: args["p_shift_id"],
            kiosk_device_id: null,
            clock_in: args["p_device_time"],
            clock_out: null,
            auto_closed_at: null,
            source: "Mobile",
          });
          entries.push(entry);
          return { id: args["p_punch_id"], time_entry_id: entry["id"] };
        }
        if (open === undefined) throw refusal("punch_not_in");
        open["clock_out"] = args["p_device_time"];
        return { id: args["p_punch_id"], time_entry_id: open["id"] };
      },
      decide_time_entry_correction: decides(
        "time_entry_corrections",
        "correction_state",
        "p_correction_id",
        "Approved",
        "Rejected",
      ),
      submit_timesheet: (args, db) => {
        Object.assign(find(db, "timesheets", args["p_timesheet_id"]), {
          timesheet_state: "Submitted",
          submitted_by: testContext().personId,
        });
        return id(7006);
      },
      decide_timesheet: decides(
        "timesheets",
        "timesheet_state",
        "p_timesheet_id",
        "Approved",
        "Rejected",
      ),
      register_kiosk_device: (args, db) => {
        const device = row("KioskDevice", id(61), {
          name: args["p_name"],
          project_id: args["p_project_id"],
          last_seen_at: null,
          revoked_at: null,
        });
        db.tables["kiosk_devices"]?.push(device);
        return [{ kiosk_device_id: device["id"], device_key: `xkio_${SHA}` }];
      },
      transition_payroll_run: moves("payroll_runs", "payroll_run_state", "p_payroll_run_id"),
      calculate_payroll_run: (args, db) => {
        find(db, "payroll_runs", args["p_payroll_run_id"])["payroll_run_state"] = "Calculated";
        return 1;
      },
      approve_payroll_run: (args, db) => {
        const r = find(db, "payroll_runs", args["p_payroll_run_id"]);
        if (r["payroll_run_state"] !== "Calculated") throw refusal("payroll_run_not_calculated");
        r["payroll_run_state"] = "Approved";
        return true;
      },
      produce_payroll_export: (args, db) => {
        const r = find(db, "payroll_runs", args["p_payroll_run_id"]);
        if (r["payroll_run_state"] !== "Approved") throw refusal("payroll_run_not_approved");
        r["payroll_run_state"] = "Exported";
        const exported = row("PayrollExport", id(84), {
          payroll_run_id: r["id"],
          provider: args["p_provider"],
          checksum_sha256: SHA,
        });
        db.tables["payroll_exports"]?.push(exported);
        return {
          payroll_export_id: exported["id"],
          file_uri: exported["file_uri"],
          checksum_sha256: SHA,
          content: "a,b\r\n",
        };
      },
      decide_time_off: decides(
        "time_off_requests",
        "time_off_state",
        "p_time_off_request_id",
        "Approved",
        "Rejected",
      ),
    },
    {
      shifts: { shift_state: "Draft", record_id: null, scope_node_id: null, engagement_id: null },
      shift_swaps: { swap_state: "Proposed" },
      time_entry_corrections: {
        correction_state: "Proposed",
        requested_by: id(4),
        proposed_break_minutes: 0,
      },
      timesheets: { timesheet_state: "Proposed", submitted_by: null, engagement_id: null },
      rate_card_lines: { canon_rate_card_id: null },
      union_local_rates: { fringe_minor: null, effective_to: null },
      wage_determinations: { effective_to: null },
      payroll_runs: { payroll_run_state: "Draft" },
      per_diems: { engagement_id: null, membership_id: null },
      time_off_requests: { time_off_state: "Proposed" },
    },
  );
  return { db, http: requests(contractApp({ handlers: [crew], db })) };
}

describe("Crew: shifts and swaps", () => {
  it("serves shifts and moves them through their lifecycle", async () => {
    const { db, http } = world();
    await expectContract(await success(http.get("/shifts")), "shifts.list");
    await expectContract(await success(http.get(`/shifts/${SHIFT}`)), "shifts.get");
    expect((await http.get(`/shifts/${MISSING}`)).status).toBe(404);
    const create = await success(
      http.post("/shifts", {
        project_id: PROJECT,
        starts_at: "2027-06-01T14:00:00.000Z",
        ends_at: "2027-06-01T22:00:00.000Z",
        time_zone: "America/New_York",
      }),
    );
    const made = (await expectContract(create, "shifts.create")) as { id: string };
    const update = await success(
      http.patch(`/shifts/${made.id}`, { ends_at: "2027-06-01T23:00:00.000Z" }),
    );
    await expectContract(update, "shifts.update");
    const publish = await success(
      http.post(`/shifts/${made.id}/transitions`, {
        expected_state: "Draft",
        to_state: "Published",
      }),
    );
    await expectContract(publish, "shifts.transition");
    const stale = await http.post(`/shifts/${made.id}/transitions`, {
      expected_state: "Draft",
      to_state: "Canceled",
    });
    expect(stale.status).toBe(409);
    const accept = await success(http.post(`/shifts/${SHIFT}/accept`));
    await expectContract(accept, "shifts.accept");
    // First-come: the caller gets the shift and no claim waits.
    const claim = await success(http.post(`/shifts/${OPEN_SHIFT}/claim`));
    const claimed = (await expectContract(claim, "shifts.claim")) as {
      membership_id: string;
      shift_state: string;
      claim: unknown;
    };
    expect(claimed).toMatchObject({ membership_id: MEMBER, shift_state: "Accepted", claim: null });
    expect((await http.post(`/shifts/${SHIFT}/claim`)).status).toBe(422);
    // Approval: the shift stays open and the response names the claim a supervisor decides.
    const waiting = await success(http.post(`/shifts/${WAITING_SHIFT}/claim`));
    expect(await expectContract(waiting, "shifts.claim")).toMatchObject({
      membership_id: null,
      shift_state: "Published",
      claim: { id: CLAIM, claim_state: "Requested" },
    });
    const again = await http.post(`/shifts/${WAITING_SHIFT}/claim`);
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ rule: "shift_claim_waiting" });
    await expectContract(await success(http.delete(`/shifts/${made.id}`)), "shifts.delete");
    expect(find(db, "shifts", made.id)["deleted_at"]).not.toBeNull();
  });

  it("asks for, decides and withdraws swaps", async () => {
    const { db, http } = world();
    await expectContract(await success(http.get("/shift-swaps")), "shiftSwaps.list");
    await expectContract(await success(http.get(`/shift-swaps/${SWAP}`)), "shiftSwaps.get");
    const create = await success(
      http.post("/shift-swaps", { shift_id: SHIFT, proposed_membership_id: OTHER_MEMBER }),
    );
    const made = (await expectContract(create, "shiftSwaps.create")) as {
      id: string;
      requested_by_membership_id: string;
      project_id: string;
    };
    expect(made).toMatchObject({ requested_by_membership_id: MEMBER, project_id: PROJECT });
    const open = await http.post("/shift-swaps", {
      shift_id: OPEN_SHIFT,
      proposed_membership_id: OTHER_MEMBER,
    });
    expect(open.status).toBe(422);
    const approve = await success(http.post(`/shift-swaps/${SWAP}/approve`));
    await expectContract(approve, "shiftSwaps.approve");
    const decline = await success(http.post(`/shift-swaps/${made.id}/decline`));
    await expectContract(decline, "shiftSwaps.decline");
    const withdraw = await success(http.post(`/shift-swaps/${made.id}/withdraw`));
    await expectContract(withdraw, "shiftSwaps.withdraw");
    expect(find(db, "shift_swaps", made.id)["swap_state"]).toBe("Canceled");
  });
});

describe("Crew: time", () => {
  it("clocks out and back in through punches", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/time-entries")), "timeEntries.list");
    await expectContract(await success(http.get(`/time-entries/${ENTRY}`)), "timeEntries.get");
    const already = await http.post("/time-entries/clock-in", { project_id: PROJECT });
    expect(already.status).toBe(422);
    const out = await success(http.post(`/time-entries/${ENTRY}/clock-out`));
    const closed = (await expectContract(out, "timeEntries.clockOut")) as { clock_out: string };
    expect(closed.clock_out).not.toBeNull();
    expect((await http.post(`/time-entries/${ENTRY}/clock-out`)).status).toBe(422);
    const clockIn = await success(
      http.post("/time-entries/clock-in", {
        project_id: PROJECT,
        shift_id: SHIFT,
        punch_id: id(32),
        device_time: "2026-10-02T13:58:00.000Z",
      }),
    );
    const opened = (await expectContract(clockIn, "timeEntries.clockIn")) as { clock_out: null };
    expect(opened.clock_out).toBeNull();
  });

  it("serves corrections, the audit trail, timesheets and approvals", async () => {
    const { http } = world();
    await expectContract(
      await success(http.get("/time-entry-corrections")),
      "timeEntryCorrections.list",
    );
    await expectContract(
      await success(http.get(`/time-entry-corrections/${CORRECTION}`)),
      "timeEntryCorrections.get",
    );
    const correction = await success(
      http.post("/time-entry-corrections", {
        time_entry_id: ENTRY,
        reason: "Forgot to clock out.",
        proposed_clock_in: "2026-10-01T14:00:00.000Z",
        proposed_clock_out: "2026-10-01T22:00:00.000Z",
      }),
    );
    await expectContract(correction, "timeEntryCorrections.create");
    const approve = await success(http.post(`/time-entry-corrections/${CORRECTION}/approve`));
    await expectContract(approve, "timeEntryCorrections.approve");

    await expectContract(
      await success(http.get("/time-entry-audit")),
      "timeEntryAuditEntries.list",
    );
    await expectContract(
      await success(http.get(`/time-entry-audit/${AUDIT}`)),
      "timeEntryAuditEntries.get",
    );

    await expectContract(await success(http.get("/timesheets")), "timesheets.list");
    await expectContract(await success(http.get(`/timesheets/${SHEET}`)), "timesheets.get");
    const sheet = await success(
      http.post("/timesheets", {
        project_id: PROJECT,
        membership_id: MEMBER,
        period_start: "2026-10-05",
        period_end: "2026-10-11",
      }),
    );
    await expectContract(sheet, "timesheets.create");
    const submit = await success(http.post(`/timesheets/${SHEET}/submit`));
    await expectContract(submit, "timesheets.submit");
    const approveSheet = await success(http.post(`/timesheets/${SHEET}/approve`));
    const approved = (await expectContract(approveSheet, "timesheets.approve")) as {
      timesheet_state: string;
    };
    expect(approved.timesheet_state).toBe("Approved");

    await expectContract(
      await success(http.get("/timesheet-approvals")),
      "timesheetApprovals.list",
    );
    await expectContract(
      await success(http.get(`/timesheet-approvals/${APPROVAL}`)),
      "timesheetApprovals.get",
    );
  });

  it("registers a kiosk, shows its key once, renames it and retires it", async () => {
    const { http } = world();
    const list = (await expectContract(
      await success(http.get("/kiosk-devices")),
      "kioskDevices.list",
    )) as { data: { device_key: string | null }[] };
    expect(list.data[0]?.device_key).toBeNull();
    await expectContract(await success(http.get(`/kiosk-devices/${KIOSK}`)), "kioskDevices.get");
    const create = await success(
      http.post("/kiosk-devices", { name: "Gate 1 Tablet", project_id: PROJECT }),
    );
    const made = (await expectContract(create, "kioskDevices.create")) as {
      id: string;
      device_key: string;
    };
    expect(made.device_key).toBe(`xkio_${SHA}`);
    const read = (await expectContract(
      await success(http.get(`/kiosk-devices/${made.id}`)),
      "kioskDevices.get",
    )) as { device_key: string | null };
    expect(read.device_key).toBeNull();
    const update = await success(http.patch(`/kiosk-devices/${made.id}`, { name: "Gate 2" }));
    await expectContract(update, "kioskDevices.update");
    await expectContract(
      await success(http.delete(`/kiosk-devices/${made.id}`)),
      "kioskDevices.delete",
    );
  });
});

describe("Crew: rates", () => {
  it("serves rate card lines with the Restricted rate masked", async () => {
    const { http } = world();
    const list = (await expectContract(
      await success(http.get("/rate-card-lines")),
      "rateCardLines.list",
    )) as { data: { rate_minor: unknown }[] };
    expect(list.data[0]?.rate_minor).toEqual({
      masked: true,
      reason: "Requires data.restricted.read.payroll.",
    });
    await expectContract(await success(http.get(`/rate-card-lines/${LINE}`)), "rateCardLines.get");
    const create = await success(
      http.post("/rate-card-lines", {
        rate_card_id: CARD,
        role_code: "5000.50.01",
        worker_classification: "EMPLOYEE",
        pay_basis: "Hourly",
        arrangement: "Per Engagement",
        overtime_rule_id: "OTR-001",
      }),
    );
    await expectContract(create, "rateCardLines.create");
    const update = await success(http.patch(`/rate-card-lines/${LINE}`, { rate_minor: 4600 }));
    await expectContract(update, "rateCardLines.update");
    await expectContract(
      await success(http.delete(`/rate-card-lines/${LINE}`)),
      "rateCardLines.delete",
    );
  });

  it("serves pay rates, overtime rules, union scales and wage determinations", async () => {
    const { http } = world();
    const rates = (await expectContract(
      await success(http.get("/pay-rates")),
      "payRates.list",
    )) as { data: { rate_minor: unknown }[] };
    expect(rates.data[0]?.rate_minor).toBe(5200);
    await expectContract(await success(http.get(`/pay-rates/${PAY_RATE}`)), "payRates.get");
    const rate = await success(
      http.post("/pay-rates", {
        membership_id: MEMBER,
        role_code: "5000.50.01",
        rate_minor: 5400,
        currency_code: "USD",
        effective_from: "2027-01-01",
      }),
    );
    await expectContract(rate, "payRates.create");

    const rules = (await expectContract(
      await success(http.get("/overtime-rules")),
      "overtimeRules.list",
    )) as { data: { jurisdiction_id: string }[] };
    const jurisdiction = encodeURIComponent(String(rules.data[0]?.jurisdiction_id));
    await expectContract(
      await success(http.get(`/overtime-rules/${jurisdiction}`)),
      "overtimeRules.get",
    );

    await expectContract(await success(http.get("/union-local-rates")), "unionLocalRates.list");
    await expectContract(
      await success(http.get(`/union-local-rates/${UNION}`)),
      "unionLocalRates.get",
    );
    const union = await success(
      http.post("/union-local-rates", {
        union_local: "IATSE Local 500",
        role_code: "5000.50.01",
        rate_minor: 5600,
        currency_code: "USD",
        effective_from: "2027-01-01",
      }),
    );
    await expectContract(union, "unionLocalRates.create");
    const unionUpdate = await success(
      http.patch(`/union-local-rates/${UNION}`, { fringe_minor: 1200 }),
    );
    await expectContract(unionUpdate, "unionLocalRates.update");
    await expectContract(
      await success(http.delete(`/union-local-rates/${UNION}`)),
      "unionLocalRates.delete",
    );

    await expectContract(
      await success(http.get("/wage-determinations")),
      "wageDeterminations.list",
    );
    await expectContract(
      await success(http.get(`/wage-determinations/${WAGE}`)),
      "wageDeterminations.get",
    );
    const wage = await success(
      http.post("/wage-determinations", {
        jurisdiction_id: "US-FL-MIAMI-DADE",
        role_code: "5000.50.01",
        minimum_rate_minor: 4800,
        currency_code: "USD",
        effective_from: "2027-01-01",
        source: "FL20270001",
      }),
    );
    await expectContract(wage, "wageDeterminations.create");
    const wageUpdate = await success(
      http.patch(`/wage-determinations/${WAGE}`, { effective_to: "2027-12-31" }),
    );
    await expectContract(wageUpdate, "wageDeterminations.update");
    await expectContract(
      await success(http.delete(`/wage-determinations/${WAGE}`)),
      "wageDeterminations.delete",
    );
  });
});

describe("Crew: payroll, per diems and time off", () => {
  it("calculates, approves and exports a payroll run", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/payroll-runs")), "payrollRuns.list");
    await expectContract(await success(http.get(`/payroll-runs/${RUN}`)), "payrollRuns.get");
    const create = await success(
      http.post("/payroll-runs", { pay_period_id: PERIOD, currency_code: "USD" }),
    );
    const made = (await expectContract(create, "payrollRuns.create")) as { id: string };
    expect((await http.post(`/payroll-runs/${RUN}/approve`)).status).toBe(422);
    const calculate = await success(http.post(`/payroll-runs/${RUN}/calculate`));
    await expectContract(calculate, "payrollRuns.calculate");
    const approve = await success(http.post(`/payroll-runs/${RUN}/approve`));
    await expectContract(approve, "payrollRuns.approve");
    const exported = await success(
      http.post("/payroll-exports", { payroll_run_id: RUN, provider: "adp" }),
    );
    await expectContract(exported, "payrollExports.create");
    const accept = await success(
      http.post(`/payroll-runs/${RUN}/transitions`, {
        expected_state: "Exported",
        to_state: "Accepted",
      }),
    );
    await expectContract(accept, "payrollRuns.transition");
    const stale = await http.post(`/payroll-runs/${made.id}/transitions`, {
      expected_state: "Calculated",
      to_state: "Canceled",
    });
    expect(stale.status).toBe(409);

    const lines = (await expectContract(
      await success(http.get("/payroll-lines")),
      "payrollLines.list",
    )) as { data: { amount_minor: unknown }[] };
    expect(lines.data[0]?.amount_minor).toMatchObject({ masked: true });
    await expectContract(
      await success(http.get(`/payroll-lines/${PAYROLL_LINE}`)),
      "payrollLines.get",
    );
    await expectContract(await success(http.get("/payroll-exports")), "payrollExports.list");
    await expectContract(
      await success(http.get(`/payroll-exports/${EXPORT}`)),
      "payrollExports.get",
    );
  });

  it("serves per diems and decides time off", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/per-diems")), "perDiems.list");
    await expectContract(await success(http.get(`/per-diems/${PER_DIEM}`)), "perDiems.get");
    const perDiem = await success(
      http.post("/per-diems", {
        project_id: PROJECT,
        membership_id: MEMBER,
        day: "2027-06-02",
        amount_minor: 6500,
        currency_code: "USD",
      }),
    );
    await expectContract(perDiem, "perDiems.create");
    const perDiemUpdate = await success(
      http.patch(`/per-diems/${PER_DIEM}`, { amount_minor: 7000 }),
    );
    await expectContract(perDiemUpdate, "perDiems.update");
    await expectContract(await success(http.delete(`/per-diems/${PER_DIEM}`)), "perDiems.delete");

    await expectContract(await success(http.get("/time-off-requests")), "timeOffRequests.list");
    await expectContract(
      await success(http.get(`/time-off-requests/${TIME_OFF}`)),
      "timeOffRequests.get",
    );
    const request = await success(
      http.post("/time-off-requests", {
        time_off_policy_id: POLICY,
        membership_id: MEMBER,
        starts_on: "2027-07-01",
        ends_on: "2027-07-02",
        hours: 16,
      }),
    );
    const made = (await expectContract(request, "timeOffRequests.create")) as { id: string };
    const approve = await success(http.post(`/time-off-requests/${TIME_OFF}/approve`));
    await expectContract(approve, "timeOffRequests.approve");
    const decline = await success(http.post(`/time-off-requests/${made.id}/decline`));
    const declined = (await expectContract(decline, "timeOffRequests.decline")) as {
      time_off_state: string;
    };
    expect(declined.time_off_state).toBe("Rejected");
  });
});
