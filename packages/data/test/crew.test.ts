import { describe, expect, it } from "vitest";
import {
  acceptShift,
  addRateCardLine,
  approvePayrollRun,
  byCode,
  calculatePayrollRun,
  cancelSwap,
  cancelTimeOff,
  claimOpenShift,
  clockIn,
  clockOut,
  createPayPeriod,
  createPayrollRun,
  createRateCard,
  createShift,
  createTimeEntry,
  createTimesheet,
  decideCorrection,
  decideSwap,
  decideTimeOff,
  decideTimesheet,
  doubleBookings,
  getCrewProject,
  getPayPeriod,
  getPayrollRun,
  getRateCanon,
  getShift,
  getSwap,
  getTimeEntry,
  getTimeOffRequest,
  getTimesheet,
  getWageHourRule,
  landed,
  listCanonRoles,
  listCrewMembers,
  listCrewProjects,
  listCurrencies,
  listEarningCodes,
  listPayPeriods,
  listPayRates,
  listPayrollExports,
  listPayrollRuns,
  listPendingCorrections,
  listRateCardLines,
  listRateCards,
  listShifts,
  listSwaps,
  listTimeEntries,
  listTimeOffPolicies,
  listTimeOffRequests,
  listTimesheets,
  nullAwareTotal,
  payrollExportFile,
  personNames,
  producePayrollExport,
  publishShifts,
  rateInForce,
  recordPayRate,
  removeRateCardLine,
  requestCorrection,
  requestSwap,
  requestTimeOff,
  restoreShift,
  scheduledMinutesByPerson,
  shiftMinutes,
  shiftTiming,
  submitTimesheet,
  toWorker,
  transitionPayPeriod,
  transitionPayrollRun,
  transitionShift,
  trashRateCard,
  trashShift,
  updatePayPeriod,
  updateRateCard,
  updateRateCardLine,
  updateShift,
  updateTimeEntry,
  voidTimeEntry,
  workedMinutes,
  type Shift,
} from "../src/crew.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

/** The fake client with `schema()` returning itself, for canon reads from xpms. */
function client(queues: Record<string, Response[]>) {
  const fake = fakeClient(queues);
  (fake.db as unknown as { schema: () => unknown }).schema = () => fake.db;
  return fake;
}

const denied = () => errorResponse("42501", "denied");
const refused = (rule: string) => errorResponse("XR001", `${rule}: Refused.`, rule);
const member = { id: "m1", person_id: "p1", person: { full_name: "Fern Field" } };

const shiftRow = {
  id: "s1",
  project_id: "pr1",
  membership_id: "m1",
  role_code: "5000.51.02",
  starts_at: "2027-06-01T12:00:00.000Z",
  ends_at: "2027-06-01T20:00:00.000Z",
  time_zone: "America/New_York",
  shift_state: "Published",
  record_id: null,
  scope_node_id: null,
  created_at: "2027-05-01T00:00:00.000Z",
  project: { project_key: "NWL", name: "Northwind" },
  membership: member,
  engagement_id: null,
  engagement: null,
};
const ledger = [
  {
    id: "l2",
    from_state: "Draft",
    to_state: "Published",
    reason: "Go.",
    created_at: "2027-05-02T00:00:00Z",
    created_by: "p9",
  },
  {
    id: "l1",
    from_state: null,
    to_state: "Draft",
    reason: "Created.",
    created_at: "2027-05-01T00:00:00Z",
    created_by: null,
  },
];

describe("shared", () => {
  it("orders codes numerically and maps workers", () => {
    expect(["5000.51.10", "5000.51.02", "0000.50.01"].sort(byCode)).toEqual([
      "0000.50.01",
      "5000.51.02",
      "5000.51.10",
    ]);
    expect(
      toWorker(null, null, { id: "e1", person_id: "p2", person: { full_name: "Ivy" } }, "e1"),
    ).toEqual({
      membershipId: "",
      personId: "p2",
      name: "Ivy",
      engagementId: "e1",
    });
    expect(toWorker(member, "m1", null, null).name).toBe("Fern Field");
    expect(landed([])).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(landed([{ id: "x" }]).ok).toBe(true);
  });

  it("reads canon roles, projects, members and names", async () => {
    const { db } = client({
      "from:role": [
        okResponse([
          { role_code: "5000.51.10", job_title: "B", discipline: "d", rank: "r" },
          { role_code: "5000.51.02", job_title: "A", discipline: "d", rank: "r" },
        ]),
        denied(),
      ],
      "from:projects": [
        okResponse([
          { id: "b", project_key: "NWX", name: "X", time_zone: "UTC", jurisdiction_id: null },
          { id: "a", project_key: "NWL", name: "L", time_zone: "UTC", jurisdiction_id: "US" },
        ]),
        okResponse({
          id: "a",
          project_key: "NWL",
          name: "L",
          time_zone: "UTC",
          jurisdiction_id: "US",
        }),
        okResponse(null),
        denied(),
      ],
      "from:memberships": [
        okResponse([{ ...member, id: "m2", person: { full_name: "Zed" } }, member]),
      ],
      "from:people": [okResponse([{ id: "p1", full_name: "Fern" }])],
    });
    const roles = await listCanonRoles(db);
    expect(roles.ok && roles.data.map((r) => r.code)).toEqual(["5000.51.02", "5000.51.10"]);
    expect((await listCanonRoles(db)).ok).toBe(false);
    const projects = await listCrewProjects(db, "o1");
    expect(projects.ok && projects.data.map((p) => p.key)).toEqual(["NWL", "NWX"]);
    expect((await getCrewProject(db, "o1", "NWL")).ok).toBe(true);
    expect(await getCrewProject(db, "o1", "ZZ")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await listCrewProjects(db, "o1")).ok).toBe(false);
    const members = await listCrewMembers(db, "o1", new Date("2027-01-01"));
    expect(members.ok && members.data.map((m) => m.name)).toEqual(["Fern Field", "Zed"]);
    const names = await personNames(db, ["p1", null, "p1"]);
    expect(names.ok && names.data.get("p1")).toBe("Fern");
    expect((await personNames(db, [null])).ok).toBe(true);
  });

  it("resolves the nearest wage-hour rule up the chain, or no answer", async () => {
    const chain = okResponse([
      { jurisdiction_id: "US", parent: null },
      { jurisdiction_id: "US-FL", parent: "US" },
      { jurisdiction_id: "US-FL-MIAMI-DADE", parent: "US-FL" },
      { jurisdiction_id: "GB", parent: null },
    ]);
    const rules = okResponse([
      { jurisdiction_id: "US", weekly_ot_after_hours: 40, min_ot_multiplier: 1.5 },
    ]);
    const { db } = client({
      "from:jurisdiction": [chain, structuredClone(chain), denied()],
      "from:wage_hour_rule": [rules, structuredClone(rules), okResponse([])],
    });
    const rule = await getWageHourRule(db, "US-FL-MIAMI-DADE");
    expect(rule.ok && rule.data).toEqual({
      jurisdictionId: "US",
      weeklyOvertimeAfterHours: 40,
      overtimeMultiplier: 1.5,
    });
    expect(await getWageHourRule(db, "GB")).toEqual({ ok: true, data: null });
    expect(await getWageHourRule(db, null)).toEqual({ ok: true, data: null });
    expect((await getWageHourRule(db, "US")).ok).toBe(false);
  });
});

describe("shifts", () => {
  it("lists with filters and maps workers and open shifts", async () => {
    const open = { ...shiftRow, id: "s2", membership_id: null, membership: null };
    const { db, calls } = client({ "from:shifts": [okResponse([shiftRow, open]), denied()] });
    const result = await listShifts(db, {
      orgId: "o1",
      projectId: "pr1",
      membershipId: "m1",
      open: true,
      from: "2027-06-01T00:00:00Z",
      to: "2027-06-08T00:00:00Z",
      states: ["Published"],
      limit: 10,
    });
    expect(result.ok && result.data[0]?.member?.name).toBe("Fern Field");
    expect(result.ok && result.data[1]?.member).toBeNull();
    expect(calls[0]?.steps).toContainEqual(["in", ["shift_state", ["Published"]]]);
    expect((await listShifts(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("reads one shift with its ledger in order", async () => {
    const { db } = client({
      "from:shifts": [okResponse(shiftRow), okResponse(null), denied(), okResponse(shiftRow)],
      "from:shift_state_transitions": [okResponse(ledger), denied()],
    });
    const detail = await getShift(db, "s1");
    expect(detail.ok && detail.data.transitions.map((t) => t.id)).toEqual(["l1", "l2"]);
    expect(await getShift(db, "x")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getShift(db, "x")).ok).toBe(false);
    expect((await getShift(db, "s1")).ok).toBe(false);
  });

  it("creates, edits, trashes and restores", async () => {
    const { db, calls } = client({
      "from:shifts": [
        okResponse({ id: "s1" }),
        errorResponse("23514", "ends"),
        okResponse([{ id: "s1" }]),
        okResponse([]),
        errorResponse("08006", "down"),
        okResponse([{ id: "s1" }]),
        errorResponse("08006", "down"),
        okResponse([{ id: "s1" }]),
        errorResponse("08006", "down"),
      ],
    });
    const input = {
      orgId: "o1",
      projectId: "pr1",
      roleCode: null,
      startsAt: "a",
      endsAt: "b",
      timeZone: "UTC",
      membershipId: null,
    };
    expect(await createShift(db, input)).toEqual({ ok: true, data: { id: "s1" } });
    expect((await createShift(db, input)).ok).toBe(false);
    expect(
      (
        await updateShift(db, "s1", {
          roleCode: "x",
          startsAt: "a",
          endsAt: "b",
          timeZone: "UTC",
          membershipId: "m1",
        })
      ).ok,
    ).toBe(true);
    expect(calls[2]?.steps[0]?.[1]).toEqual([
      { role_code: "x", starts_at: "a", ends_at: "b", time_zone: "UTC", membership_id: "m1" },
    ]);
    expect(await updateShift(db, "s1", {})).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await updateShift(db, "s1", {})).ok).toBe(false);
    expect((await trashShift(db, "s1", new Date("2027-01-01"))).ok).toBe(true);
    expect((await trashShift(db, "s1")).ok).toBe(false);
    expect((await restoreShift(db, "s1")).ok).toBe(true);
    expect((await restoreShift(db, "s1")).ok).toBe(false);
  });

  it("calls the lifecycle RPCs and returns refusals", async () => {
    const { db, calls } = client({
      "rpc:transition_shift": [okResponse("t1"), refused("shift_state_conflict")],
      "rpc:publish_shifts": [okResponse(2), denied()],
      "rpc:accept_shift": [okResponse("t2"), denied()],
      "rpc:claim_open_shift": [okResponse("t3"), refused("shift_double_booked")],
    });
    expect(await transitionShift(db, "s1", "Draft", "Published", "Go.")).toEqual({
      ok: true,
      data: { transitionId: "t1" },
    });
    expect(await transitionShift(db, "s1", "Draft", "Published", "Go.")).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "shift_state_conflict", message: "Refused." },
    });
    expect(await publishShifts(db, ["s1", "s2"], "Go.")).toEqual({
      ok: true,
      data: { published: 2 },
    });
    expect(calls[2]?.steps[0]?.[1]).toEqual([{ p_shift_ids: ["s1", "s2"], p_reason: "Go." }]);
    expect((await publishShifts(db, [], "Go.")).ok).toBe(false);
    expect((await acceptShift(db, "s1", "Yes.")).ok).toBe(true);
    expect((await acceptShift(db, "s1", "Yes.")).ok).toBe(false);
    expect((await claimOpenShift(db, "s1", "Mine.")).ok).toBe(true);
    expect((await claimOpenShift(db, "s1", "Mine.")).ok).toBe(false);
  });

  it("times shifts and finds double bookings and scheduled minutes", () => {
    const mk = (
      id: string,
      start: string,
      end: string,
      person: string | null,
      state: Shift["state"] = "Accepted",
    ): Shift => ({
      id,
      projectId: "pr1",
      projectKey: "NWL",
      projectName: "N",
      member: person
        ? { membershipId: `m-${person}`, personId: person, name: person, engagementId: null }
        : null,
      roleCode: null,
      startsAt: start,
      endsAt: end,
      timeZone: "UTC",
      state,
      recordId: null,
      scopeNodeId: null,
      createdAt: start,
    });
    const a = mk("a", "2027-06-01T08:00:00Z", "2027-06-01T16:00:00Z", "p1");
    const b = mk("b", "2027-06-01T12:00:00Z", "2027-06-01T18:00:00Z", "p1");
    const c = mk("c", "2027-06-01T12:00:00Z", "2027-06-01T18:00:00Z", "p2");
    const d = mk("d", "2027-06-02T08:00:00Z", "2027-06-02T10:00:00Z", "p1", "Canceled");
    const e = mk("e", "2027-06-01T09:00:00Z", "2027-06-01T10:00:00Z", null);
    expect(doubleBookings([a, b, c, d, e]).map(([x, y]) => `${x.id}${y.id}`)).toEqual(["ab"]);
    expect(scheduledMinutesByPerson([a, b, c, d, e]).get("p1")).toBe(840);
    expect(shiftMinutes(a)).toBe(480);
    expect(shiftTiming(a, new Date("2027-06-01T07:00:00Z"))).toBe("upcoming");
    expect(shiftTiming(a, new Date("2027-06-01T09:00:00Z"))).toBe("in-progress");
    expect(shiftTiming(a, new Date("2027-06-01T17:00:00Z"))).toBe("over");
  });
});

describe("swaps", () => {
  const swapRow = {
    id: "w1",
    shift_id: "s1",
    project_id: "pr1",
    swap_state: "Proposed",
    created_at: "2027-05-01T00:00:00Z",
    requested_by_membership_id: "m1",
    proposed_membership_id: "m2",
    shift: { starts_at: "a", ends_at: "b", role_code: null, project: { project_key: "NWL" } },
    requester: member,
    proposed: null,
  };

  it("lists, reads and writes swaps", async () => {
    const { db } = client({
      "from:shift_swaps": [
        okResponse([swapRow]),
        denied(),
        okResponse(swapRow),
        okResponse(null),
        okResponse({ id: "w1" }),
        refused("swap_not_on_shift"),
        denied(),
        okResponse(swapRow),
      ],
      "from:swap_state_transitions": [okResponse(ledger), denied()],
      "rpc:decide_shift_swap": [okResponse("t1"), refused("sod_swap_requester")],
      "rpc:cancel_shift_swap": [okResponse("t2"), denied()],
    });
    const list = await listSwaps(db, { orgId: "o1", projectId: "pr1", states: ["Proposed"] });
    expect(list.ok && list.data[0]?.proposed.name).toBeNull();
    expect((await listSwaps(db, { orgId: "o1" })).ok).toBe(false);
    expect((await getSwap(db, "w1")).ok).toBe(true);
    expect((await getSwap(db, "w2")).ok).toBe(false);
    const input = {
      orgId: "o1",
      projectId: "pr1",
      shiftId: "s1",
      requestedByMembershipId: "m1",
      proposedMembershipId: "m2",
    };
    expect(await requestSwap(db, input)).toEqual({ ok: true, data: { id: "w1" } });
    expect((await requestSwap(db, input)).ok).toBe(false);
    expect((await getSwap(db, "w1")).ok).toBe(false);
    expect((await getSwap(db, "w1")).ok).toBe(false);
    expect((await decideSwap(db, "w1", "Approved", "Ok.")).ok).toBe(true);
    expect((await decideSwap(db, "w1", "Approved", "Ok.")).ok).toBe(false);
    expect((await cancelSwap(db, "w1", "No.")).ok).toBe(true);
    expect((await cancelSwap(db, "w1", "No.")).ok).toBe(false);
  });
});

describe("time entries and timesheets", () => {
  const entryRow = {
    id: "e1",
    project_id: "pr1",
    membership_id: "m1",
    engagement_id: null,
    engagement: null,
    shift_id: "s1",
    clock_in: "2027-06-01T12:00:00.000Z",
    clock_out: "2027-06-01T20:00:00.000Z",
    break_minutes: 30,
    source: "Web",
    created_at: "2027-06-01T12:00:00.000Z",
    project: { project_key: "NWL" },
    membership: member,
  };
  const correction = {
    id: "c1",
    time_entry_id: "e1",
    requested_by: "p1",
    proposed_clock_in: "a",
    proposed_clock_out: null,
    proposed_break_minutes: 0,
    reason: "Early.",
    correction_state: "Proposed",
    created_at: "x",
  };

  it("computes worked minutes", () => {
    expect(
      workedMinutes({
        clockIn: "2027-06-01T12:00:00Z",
        clockOut: "2027-06-01T20:00:00Z",
        breakMinutes: 30,
      }),
    ).toBe(450);
    expect(
      workedMinutes({ clockIn: "2027-06-01T12:00:00Z", clockOut: null, breakMinutes: 0 }),
    ).toBeNull();
    expect(
      workedMinutes({
        clockIn: "2027-06-01T12:00:00Z",
        clockOut: "2027-06-01T12:10:00Z",
        breakMinutes: 30,
      }),
    ).toBe(0);
  });

  it("lists, reads and writes entries and corrections", async () => {
    const { db, calls } = client({
      "from:time_entries": [
        okResponse([entryRow]),
        denied(),
        okResponse(entryRow),
        okResponse(null),
        okResponse(entryRow),
        okResponse(entryRow),
        okResponse({ id: "e1" }),
        refused("time_entry_overlap"),
        okResponse([{ id: "e1" }]),
        okResponse([]),
        okResponse({ id: "e2" }),
        denied(),
        okResponse([{ id: "e1" }]),
        denied(),
        okResponse([{ id: "e1" }]),
        denied(),
      ],
      "from:time_entry_audit": [
        okResponse([
          {
            id: "a1",
            created_at: "x",
            created_by: "p1",
            old_values: null,
            new_values: { clock_in: "a" },
          },
        ]),
        denied(),
        okResponse([]),
      ],
      "from:time_entry_corrections": [
        okResponse([correction]),
        okResponse([]),
        denied(),
        okResponse([correction]),
        denied(),
        okResponse({ id: "c1" }),
        denied(),
      ],
      "rpc:decide_time_entry_correction": [okResponse("t1"), denied()],
    });
    const list = await listTimeEntries(db, {
      orgId: "o1",
      projectId: "pr1",
      membershipId: "m1",
      engagementId: "g1",
      shiftId: "s1",
      from: "a",
      to: "b",
      openOnly: true,
    });
    expect(list.ok && list.data[0]?.member.name).toBe("Fern Field");
    expect(calls[0]?.steps).toContainEqual(["is", ["clock_out", null]]);
    expect((await listTimeEntries(db, { orgId: "o1" })).ok).toBe(false);
    const detail = await getTimeEntry(db, "e1");
    expect(detail.ok && detail.data.audit[0]?.before).toBeNull();
    expect(detail.ok && detail.data.corrections[0]?.reason).toBe("Early.");
    expect((await getTimeEntry(db, "x")).ok).toBe(false);
    expect((await getTimeEntry(db, "e1")).ok).toBe(false);
    expect((await getTimeEntry(db, "e1")).ok).toBe(false);
    expect(
      await clockIn(db, {
        orgId: "o1",
        projectId: "pr1",
        membershipId: "m1",
        source: "Mobile",
        at: new Date("2027-06-01T12:00:00Z"),
      }),
    ).toEqual({ ok: true, data: { id: "e1" } });
    expect(
      await clockIn(db, {
        orgId: "o1",
        projectId: "pr1",
        membershipId: "m1",
        shiftId: "s1",
        kioskDeviceId: "k1",
        source: "Kiosk",
      }),
    ).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "time_entry_overlap", message: "Refused." },
    });
    expect((await clockOut(db, "e1", 30, new Date("2027-06-01T20:00:00Z"))).ok).toBe(true);
    expect((await clockOut(db, "e1", 0)).ok).toBe(false);
    const manual = {
      orgId: "o1",
      projectId: "pr1",
      membershipId: "m1",
      shiftId: null,
      clockIn: "a",
      clockOut: null,
      breakMinutes: 0,
    };
    expect((await createTimeEntry(db, manual)).ok).toBe(true);
    expect((await createTimeEntry(db, manual)).ok).toBe(false);
    expect(
      (await updateTimeEntry(db, "e1", { clockIn: "a", clockOut: "b", breakMinutes: 5 })).ok,
    ).toBe(true);
    expect(
      (await updateTimeEntry(db, "e1", { clockIn: "a", clockOut: "b", breakMinutes: 5 })).ok,
    ).toBe(false);
    expect((await voidTimeEntry(db, "e1", new Date("2027-06-02"))).ok).toBe(true);
    expect((await voidTimeEntry(db, "e1")).ok).toBe(false);
    expect((await listPendingCorrections(db, "o1")).ok).toBe(true);
    expect((await listPendingCorrections(db, "o1")).ok).toBe(false);
    const ask = {
      orgId: "o1",
      timeEntryId: "e1",
      clockIn: "a",
      clockOut: null,
      breakMinutes: 0,
      reason: " Early. ",
    };
    expect((await requestCorrection(db, ask)).ok).toBe(true);
    expect((await requestCorrection(db, ask)).ok).toBe(false);
    expect((await decideCorrection(db, "c1", "Approved", "Ok.")).ok).toBe(true);
    expect((await decideCorrection(db, "c1", "Approved", "Ok.")).ok).toBe(false);
  });

  it("lists timesheets with derived hours and reads one in full", async () => {
    const sheet = {
      id: "t1",
      org_id: "o1",
      project_id: "pr1",
      membership_id: "m1",
      engagement_id: null,
      engagement: null,
      period_start: "2027-06-01",
      period_end: "2027-06-07",
      timesheet_state: "Submitted",
      submitted_by: "p1",
      project: { project_key: "NWL" },
      membership: member,
    };
    const { db } = client({
      "from:timesheets": [
        okResponse([sheet]),
        okResponse([]),
        denied(),
        okResponse(sheet),
        okResponse(null),
        okResponse({ id: "t1" }),
        denied(),
      ],
      "from:timesheet_hours": [
        okResponse([{ timesheet_id: "t1", worked_minutes: 450, has_open_entry: false }]),
        okResponse([{ timesheet_id: "t1", worked_minutes: 450, has_open_entry: true }]),
      ],
      "from:timesheet_approvals": [
        okResponse([
          { id: "a1", approved_by: "p9", approved_minutes: 450, created_at: "x", voided_at: null },
        ]),
      ],
      "from:timesheet_state_transitions": [okResponse(ledger)],
      "from:time_entries": [okResponse([entryRow])],
      "rpc:submit_timesheet": [okResponse("x1"), refused("timesheet_open_entry")],
      "rpc:decide_timesheet": [okResponse("x2"), refused("sod_timesheet_submitter")],
    });
    const list = await listTimesheets(db, {
      orgId: "o1",
      projectId: "pr1",
      membershipId: "m1",
      states: ["Submitted"],
    });
    expect(list.ok && list.data[0]?.workedMinutes).toBe(450);
    expect(await listTimesheets(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    expect((await listTimesheets(db, { orgId: "o1" })).ok).toBe(false);
    const detail = await getTimesheet(db, "t1");
    expect(detail.ok && detail.data.hasOpenEntry).toBe(true);
    expect(detail.ok && detail.data.entries).toHaveLength(1);
    expect(detail.ok && detail.data.approvals[0]?.approvedMinutes).toBe(450);
    expect((await getTimesheet(db, "x")).ok).toBe(false);
    const input = {
      orgId: "o1",
      projectId: "pr1",
      membershipId: "m1",
      periodStart: "a",
      periodEnd: "b",
    };
    expect((await createTimesheet(db, input)).ok).toBe(true);
    expect((await createTimesheet(db, input)).ok).toBe(false);
    expect((await submitTimesheet(db, "t1", "Go.")).ok).toBe(true);
    expect((await submitTimesheet(db, "t1", "Go.")).ok).toBe(false);
    expect((await decideTimesheet(db, "t1", "Approved", "Ok.")).ok).toBe(true);
    expect((await decideTimesheet(db, "t1", "Approved", "Ok.")).ok).toBe(false);
  });
});

describe("rates", () => {
  it("lists and writes rate cards and lines, masking rates", async () => {
    const { db } = client({
      "from:rate_cards": [
        okResponse([
          {
            id: "c2",
            name: "Old",
            currency_code: "USD",
            effective_from: "2026-01-01",
            effective_to: "2026-12-31",
            rate_card_lines: [],
          },
          {
            id: "c1",
            name: "Now",
            currency_code: "USD",
            effective_from: "2027-01-01",
            effective_to: null,
            rate_card_lines: [
              { id: "l1", deleted_at: null },
              { id: "l2", deleted_at: "x" },
            ],
          },
        ]),
        denied(),
        okResponse({ id: "c1" }),
        denied(),
        okResponse([{ id: "c1" }]),
        denied(),
        okResponse([{ id: "c1" }]),
        denied(),
      ],
      "from:rate_card_lines_masked": [
        okResponse([
          {
            id: "l2",
            rate_card_id: "c1",
            role_code: "5000.51.10",
            worker_classification: "EMPLOYEE",
            pay_basis: "Hourly",
            arrangement: "Per Engagement",
            canon_rate_card_id: null,
            overtime_rule_id: "OTR-001",
            rate_minor: null,
            is_masked: true,
          },
          {
            id: "l1",
            rate_card_id: "c1",
            role_code: "5000.51.02",
            worker_classification: "EMPLOYEE",
            pay_basis: "Hourly",
            arrangement: "Per Engagement",
            canon_rate_card_id: "LRC-001",
            overtime_rule_id: "OTR-001",
            rate_minor: 3200,
            is_masked: false,
          },
        ]),
        denied(),
      ],
      "from:rate_card_lines": [
        okResponse({ id: "l3" }),
        refused("x"),
        okResponse([{ id: "l1" }]),
        denied(),
        okResponse([{ id: "l1" }]),
        denied(),
      ],
    });
    const cards = await listRateCards(db, "o1");
    expect(cards.ok && cards.data.map((c) => [c.id, c.lineCount])).toEqual([
      ["c1", 1],
      ["c2", 0],
    ]);
    expect((await listRateCards(db, "o1")).ok).toBe(false);
    const input = {
      name: " Crew ",
      currencyCode: "USD",
      effectiveFrom: "2027-01-01",
      effectiveTo: null,
    };
    expect((await createRateCard(db, "o1", input)).ok).toBe(true);
    expect((await createRateCard(db, "o1", input)).ok).toBe(false);
    expect((await updateRateCard(db, "c1", input)).ok).toBe(true);
    expect((await updateRateCard(db, "c1", input)).ok).toBe(false);
    expect((await trashRateCard(db, "c1", new Date("2027-01-01"))).ok).toBe(true);
    expect((await trashRateCard(db, "c1")).ok).toBe(false);
    const lines = await listRateCardLines(db, "c1");
    expect(lines.ok && lines.data.map((l) => [l.roleCode, l.rateMinor, l.masked])).toEqual([
      ["5000.51.02", 3200, false],
      ["5000.51.10", null, true],
    ]);
    expect((await listRateCardLines(db, "c1")).ok).toBe(false);
    const line = {
      roleCode: "5000.51.02",
      workerClassification: "EMPLOYEE",
      payBasis: "Hourly",
      arrangement: "Per Engagement",
      overtimeRuleId: "OTR-001",
      canonRateCardId: null,
      rateMinor: null,
    };
    expect((await addRateCardLine(db, "o1", "c1", line)).ok).toBe(true);
    expect((await addRateCardLine(db, "o1", "c1", line)).ok).toBe(false);
    expect(
      (await updateRateCardLine(db, "l1", { rateMinor: null, overtimeRuleId: "OTR-002" })).ok,
    ).toBe(true);
    expect((await updateRateCardLine(db, "l1", {})).ok).toBe(false);
    expect((await removeRateCardLine(db, "l1", new Date("2027-01-01"))).ok).toBe(true);
    expect((await removeRateCardLine(db, "l1")).ok).toBe(false);
  });

  it("reads rate canon, currencies and the pay rate ledger", async () => {
    const { db } = client({
      "from:worker_classification": [
        okResponse([
          { code: "IC", label: "Independent Contractor", sort_order: 2 },
          { code: "EMPLOYEE", label: "Employee", sort_order: 1 },
        ]),
        denied(),
      ],
      "from:pay_basis_classification": [
        okResponse([{ pay_basis: "Hourly", worker_classification: "EMPLOYEE" }]),
        okResponse([]),
      ],
      "from:arrangement_classification": [
        okResponse([{ arrangement: "Per Engagement", worker_classification: "EMPLOYEE" }]),
        okResponse([]),
      ],
      "from:overtime_rule": [
        okResponse([
          { rule_id: "OTR-002", name: "Exempt", ot_multiplier: 1, dt_multiplier: 1 },
          { rule_id: "OTR-001", name: "Standard", ot_multiplier: 1.5, dt_multiplier: 2 },
        ]),
        okResponse([]),
      ],
      "from:rate_card": [
        okResponse([
          {
            rate_card_id: "LRC-001",
            role_code: "5000.51.02",
            worker_classification: "EMPLOYEE",
            pay_basis: "Hourly",
            arrangement: "Per Engagement",
            overtime_rule_id: "OTR-001",
            currency_code: "USD",
          },
        ]),
        okResponse([]),
      ],
      "from:currencies": [
        okResponse([{ currency_code: "USD" }, { currency_code: "EUR" }, { currency_code: null }]),
        denied(),
      ],
      "from:pay_rates_masked": [
        okResponse([
          {
            id: "r1",
            membership_id: "m1",
            role_code: "5000.51.02",
            currency_code: "USD",
            effective_from: "2027-01-01",
            rate_minor: 3200,
            is_masked: false,
          },
          {
            id: "r2",
            membership_id: "m1",
            role_code: "5000.51.02",
            currency_code: "USD",
            effective_from: "2027-06-01",
            rate_minor: null,
            is_masked: true,
          },
        ]),
        denied(),
        okResponse([]),
      ],
      "from:memberships": [okResponse([member])],
      "from:pay_rates": [okResponse({ id: "r3" }), denied()],
    });
    const canon = await getRateCanon(db);
    expect(canon.ok && canon.data.classifications.map((c) => c.code)).toEqual(["EMPLOYEE", "IC"]);
    expect(canon.ok && canon.data.overtimeRules.map((r) => r.id)).toEqual(["OTR-001", "OTR-002"]);
    expect((await getRateCanon(db)).ok).toBe(false);
    const currencies = await listCurrencies(db);
    expect(currencies.ok && currencies.data).toEqual(["EUR", "USD"]);
    expect((await listCurrencies(db)).ok).toBe(false);
    const rates = await listPayRates(db, { orgId: "o1", membershipId: "m1" });
    expect(rates.ok && rates.data.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(rates.ok && rateInForce(rates.data, "m1", "5000.51.02", "2027-03-01")?.id).toBe("r1");
    expect(rates.ok && rateInForce(rates.data, "m1", "5000.51.02", "2026-01-01")).toBeNull();
    expect((await listPayRates(db, { orgId: "o1" })).ok).toBe(false);
    expect(await listPayRates(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    const entry = {
      orgId: "o1",
      membershipId: "m1",
      roleCode: "5000.51.02",
      rateMinor: 3200,
      currencyCode: "USD",
      effectiveFrom: "2027-01-01",
    };
    expect((await recordPayRate(db, entry)).ok).toBe(true);
    expect((await recordPayRate(db, entry)).ok).toBe(false);
  });
});

describe("payroll", () => {
  const run = {
    id: "r1",
    pay_period_id: "pp1",
    currency_code: "USD",
    payroll_run_state: "Approved",
    created_by: "p1",
    created_at: "x",
    pay_period: { starts_on: "2027-06-01", ends_on: "2027-06-14" },
  };

  it("totals null-aware", () => {
    expect(nullAwareTotal([])).toBe(0);
    expect(nullAwareTotal([100, 250])).toBe(350);
    expect(nullAwareTotal([100, null])).toBeNull();
  });

  it("manages pay periods", async () => {
    const { db } = client({
      "from:pay_periods": [
        okResponse([
          {
            id: "pp1",
            starts_on: "a",
            ends_on: "b",
            pay_period_state: "Open",
            payroll_runs: [
              { id: "r1", deleted_at: null },
              { id: "r2", deleted_at: "x" },
            ],
          },
        ]),
        denied(),
        okResponse({
          id: "pp1",
          org_id: "o1",
          starts_on: "a",
          ends_on: "b",
          pay_period_state: "Open",
        }),
        okResponse(null),
        okResponse({ id: "pp1" }),
        refused("pay_period_overlap"),
        okResponse([{ id: "pp1" }]),
        denied(),
      ],
      "from:pay_period_state_transitions": [okResponse(ledger)],
      "from:payroll_runs": [okResponse([run])],
      "rpc:transition_pay_period": [okResponse("t1"), refused("pay_period_transition_not_allowed")],
    });
    const list = await listPayPeriods(db, "o1");
    expect(list.ok && list.data[0]?.runCount).toBe(1);
    expect((await listPayPeriods(db, "o1")).ok).toBe(false);
    const detail = await getPayPeriod(db, "pp1");
    expect(detail.ok && detail.data.runs).toHaveLength(1);
    expect((await getPayPeriod(db, "x")).ok).toBe(false);
    expect((await createPayPeriod(db, "o1", { startsOn: "a", endsOn: "b" })).ok).toBe(true);
    expect((await createPayPeriod(db, "o1", { startsOn: "a", endsOn: "b" })).ok).toBe(false);
    expect((await updatePayPeriod(db, "pp1", { startsOn: "a", endsOn: "b" })).ok).toBe(true);
    expect((await updatePayPeriod(db, "pp1", { startsOn: "a", endsOn: "b" })).ok).toBe(false);
    expect((await transitionPayPeriod(db, "pp1", "Open", "Closed", "Cutoff.")).ok).toBe(true);
    expect((await transitionPayPeriod(db, "pp1", "Posted", "Open", "Reopen.")).ok).toBe(false);
  });

  it("reads runs with masked, null-aware lines and their exports", async () => {
    const { db } = client({
      "from:payroll_runs": [
        okResponse(run),
        okResponse(null),
        okResponse(run),
        okResponse({ id: "r2" }),
        denied(),
        okResponse([run]),
        denied(),
      ],
      "from:payroll_line_amounts": [
        okResponse([
          {
            id: "l1",
            membership_id: "m1",
            earning_code_id: "e1",
            hours: 40,
            rate_minor: 3200,
            amount_minor: 128000,
            is_masked: false,
          },
          {
            id: "l2",
            membership_id: "m1",
            earning_code_id: "e2",
            hours: 2.5,
            rate_minor: 4800,
            amount_minor: 12000,
            is_masked: false,
          },
        ]),
        okResponse([
          {
            id: "l1",
            membership_id: "m1",
            earning_code_id: "e1",
            hours: 40,
            rate_minor: null,
            amount_minor: null,
            is_masked: true,
          },
        ]),
      ],
      "from:earning_codes": [
        okResponse([
          { id: "e1", code: "REG", name: "Regular", is_overtime: false },
          { id: "e2", code: "OT", name: "Overtime", is_overtime: true },
        ]),
        okResponse([]),
        okResponse([{ id: "e1", code: "REG", name: "Regular", is_overtime: false }]),
        denied(),
      ],
      "from:payroll_exports": [
        okResponse([
          {
            id: "x1",
            payroll_run_id: "r1",
            provider: "CSV",
            file_uri: "u",
            checksum_sha256: "c",
            created_at: "t",
            created_by: "p1",
          },
        ]),
        okResponse([]),
        okResponse([
          {
            id: "x1",
            payroll_run_id: "r1",
            provider: "CSV",
            file_uri: "u",
            checksum_sha256: "c",
            created_at: "t",
            created_by: "p1",
            run,
          },
        ]),
        denied(),
      ],
      "from:payroll_run_state_transitions": [okResponse(ledger), okResponse([])],
      "from:memberships": [okResponse([member]), okResponse([member])],
    });
    const detail = await getPayrollRun(db, "r1");
    expect(detail.ok && detail.data.totalMinor).toBe(140000);
    expect(detail.ok && detail.data.totalHours).toBe(42.5);
    expect(detail.ok && detail.data.lines.map((l) => l.earningCode)).toEqual(["OT", "REG"]);
    expect((await getPayrollRun(db, "x")).ok).toBe(false);
    const masked = await getPayrollRun(db, "r1");
    expect(masked.ok && masked.data.totalMinor).toBeNull();
    expect(
      (await createPayrollRun(db, { orgId: "o1", payPeriodId: "pp1", currencyCode: "USD" })).ok,
    ).toBe(true);
    expect(
      (await createPayrollRun(db, { orgId: "o1", payPeriodId: "pp1", currencyCode: "USD" })).ok,
    ).toBe(false);
    expect(
      (await listPayrollRuns(db, { orgId: "o1", payPeriodId: "pp1", states: ["Approved"] })).ok,
    ).toBe(true);
    expect((await listPayrollRuns(db, { orgId: "o1" })).ok).toBe(false);
    const exports = await listPayrollExports(db, "o1");
    expect(exports.ok && exports.data[0]?.run?.state).toBe("Approved");
    expect((await listPayrollExports(db, "o1")).ok).toBe(false);
    expect((await listEarningCodes(db, "o1")).ok).toBe(true);
    expect((await listEarningCodes(db, "o1")).ok).toBe(false);
  });

  it("calculates, approves, moves and exports runs", async () => {
    const file = { payroll_export_id: "x1", file_uri: "u", checksum_sha256: "c", content: "a,b\n" };
    const { db } = client({
      "rpc:calculate_payroll_run": [okResponse(2), refused("payroll_rate_missing")],
      "rpc:approve_payroll_run": [okResponse(false), refused("sod_approval_requester")],
      "rpc:transition_payroll_run": [
        okResponse("t1"),
        refused("payroll_run_transition_not_allowed"),
      ],
      "rpc:produce_payroll_export": [okResponse(file), refused("step_up_required")],
      "rpc:payroll_export_file": [okResponse(file), refused("payroll_export_changed")],
    });
    expect(await calculatePayrollRun(db, "r1", "Calc.")).toEqual({ ok: true, data: { lines: 2 } });
    expect((await calculatePayrollRun(db, "r1", "Calc.")).ok).toBe(false);
    expect(await approvePayrollRun(db, "r1", "Ok.")).toEqual({
      ok: true,
      data: { complete: false },
    });
    expect((await approvePayrollRun(db, "r1", "Ok.")).ok).toBe(false);
    expect((await transitionPayrollRun(db, "r1", "Exported", "Accepted", "Ok.")).ok).toBe(true);
    expect((await transitionPayrollRun(db, "r1", "Draft", "Accepted", "Skip.")).ok).toBe(false);
    const produced = await producePayrollExport(db, "r1", "CSV");
    expect(produced.ok && produced.data.content).toBe("a,b\n");
    expect(await producePayrollExport(db, "r1", "CSV")).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "step_up_required", message: "Refused." },
    });
    expect((await payrollExportFile(db, "x1")).ok).toBe(true);
    expect((await payrollExportFile(db, "x1")).ok).toBe(false);
  });
});

describe("time off", () => {
  const req = {
    id: "q1",
    time_off_policy_id: "pol1",
    membership_id: "m1",
    starts_on: "2027-07-01",
    ends_on: "2027-07-02",
    hours: 16,
    time_off_state: "Proposed",
    created_by: "p1",
    created_at: "x",
    policy: { name: "Paid Time Off" },
    membership: member,
  };

  it("lists policies and requests and moves requests", async () => {
    const { db } = client({
      "from:time_off_policies": [
        okResponse([
          { id: "pol1", name: "Paid Time Off", accrual_hours_per_period: "4" },
          { id: "pol2", name: "Unpaid", accrual_hours_per_period: null },
        ]),
        denied(),
      ],
      "from:time_off_requests": [
        okResponse([req]),
        denied(),
        okResponse(req),
        okResponse(null),
        denied(),
        okResponse({ id: "q1" }),
        denied(),
      ],
      "from:time_off_state_transitions": [okResponse(ledger)],
      "rpc:decide_time_off": [okResponse("t1"), refused("sod_time_off_requester")],
      "rpc:cancel_time_off": [okResponse("t2"), denied()],
    });
    const policies = await listTimeOffPolicies(db, "o1");
    expect(policies.ok && policies.data.map((p) => p.accrualHoursPerPeriod)).toEqual([4, null]);
    expect((await listTimeOffPolicies(db, "o1")).ok).toBe(false);
    const list = await listTimeOffRequests(db, {
      orgId: "o1",
      membershipId: "m1",
      states: ["Proposed"],
    });
    expect(list.ok && list.data[0]?.policyName).toBe("Paid Time Off");
    expect((await listTimeOffRequests(db, { orgId: "o1" })).ok).toBe(false);
    expect((await getTimeOffRequest(db, "q1")).ok).toBe(true);
    expect((await getTimeOffRequest(db, "x")).ok).toBe(false);
    expect((await getTimeOffRequest(db, "x")).ok).toBe(false);
    const input = {
      orgId: "o1",
      policyId: "pol1",
      membershipId: "m1",
      startsOn: "a",
      endsOn: "b",
      hours: 8,
    };
    expect((await requestTimeOff(db, input)).ok).toBe(true);
    expect((await requestTimeOff(db, input)).ok).toBe(false);
    expect((await decideTimeOff(db, "q1", "Approved", "Ok.")).ok).toBe(true);
    expect((await decideTimeOff(db, "q1", "Approved", "Ok.")).ok).toBe(false);
    expect((await cancelTimeOff(db, "q1", "Approved", "Plans changed.")).ok).toBe(true);
    expect((await cancelTimeOff(db, "q1", "Approved", "Plans changed.")).ok).toBe(false);
  });
});
