import { describe, expect, it } from "vitest";
import {
  assignRosterShift,
  getTimesheet,
  listAgencyEngagements,
  listAssignableRosterEntries,
  listRosterTrainingRecords,
  listShifts,
  listSupervisorPunchers,
  listTimesheets,
  rosterTrainingSummary,
  unassignRosterShift,
  verifyRosterTraining,
} from "../src/crew.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const refused = (rule: string) => errorResponse("XR001", `${rule}: Refused.`, rule);

const baseShift = {
  project_id: "pr1",
  membership_id: null,
  role_code: "5000.51.02",
  starts_at: "2027-06-01T12:00:00.000Z",
  ends_at: "2027-06-01T20:00:00.000Z",
  time_zone: "America/New_York",
  shift_state: "Published",
  record_id: null,
  scope_node_id: null,
  created_at: "2027-05-01T00:00:00.000Z",
  project: { project_key: "NWL", name: "Northwind" },
  membership: null,
};

describe("agency staff time (R12)", () => {
  const sheet = {
    id: "ts1",
    org_id: "o1",
    project_id: "pr1",
    membership_id: null,
    membership: null,
    engagement_id: null,
    engagement: null,
    roster_entry_id: "re1",
    period_start: "2027-06-01",
    period_end: "2027-06-07",
    timesheet_state: "Submitted",
    submitted_by: "p1",
    project: { project_key: "NWL" },
  };
  const entry = {
    id: "te1",
    project_id: "pr1",
    membership_id: null,
    membership: null,
    engagement_id: null,
    engagement: null,
    roster_entry_id: "re1",
    shift_id: "held",
    clock_in: "2027-06-01T12:00:00.000Z",
    clock_out: "2027-06-01T20:00:00.000Z",
    break_minutes: 30,
    source: "Mobile",
    created_at: "2027-06-01T12:00:00.000Z",
    project: { project_key: "NWL" },
  };
  const person = okResponse([{ id: "re1", person_id: "p1", full_name: "Stella Okafor" }]);

  it("names the agency staff member on their timesheet and its entries", async () => {
    const { db } = fakeClient({
      "from:timesheets": [okResponse([sheet]), okResponse(sheet)],
      "from:timesheet_hours": [
        okResponse([{ timesheet_id: "ts1", worked_minutes: 450, has_open_entry: false }]),
        okResponse([{ timesheet_id: "ts1", worked_minutes: 450, has_open_entry: false }]),
      ],
      "from:roster_entry_people": [person, person, person],
      "from:timesheet_approvals": [okResponse([])],
      "from:timesheet_state_transitions": [okResponse([])],
      "from:time_entries": [okResponse([entry])],
    });
    const list = await listTimesheets(db, { orgId: "o1" });
    expect(list.ok && list.data[0]?.member).toEqual({
      membershipId: "",
      personId: "p1",
      name: "Stella Okafor",
      engagementId: null,
      rosterEntryId: "re1",
    });
    const detail = await getTimesheet(db, "ts1");
    expect(detail.ok && detail.data.member.name).toBe("Stella Okafor");
    expect(detail.ok && detail.data.entries[0]?.member).toMatchObject({
      personId: "p1",
      name: "Stella Okafor",
      rosterEntryId: "re1",
    });
  });
});

describe("agency shifts (R12)", () => {
  it("names the agency on a slot and the person on a roster shift", async () => {
    const { db, calls } = fakeClient({
      "from:shifts": [
        okResponse([
          {
            ...baseShift,
            id: "slot",
            engagement_id: "eng",
            engagement: { id: "eng", person_id: null, person: null },
            roster_entry_id: null,
          },
          {
            ...baseShift,
            id: "held",
            engagement_id: null,
            engagement: null,
            roster_entry_id: "re1",
          },
          {
            ...baseShift,
            id: "open",
            engagement_id: null,
            engagement: null,
            roster_entry_id: null,
          },
        ]),
      ],
      "from:roster_entry_people": [
        okResponse([
          { id: "re1", person_id: "p1", full_name: "Stella Okafor", party_name: "Crestline" },
        ]),
      ],
      "from:engagement_board": [
        okResponse([{ engagement_id: "eng", account_name: "Crestline Staffing" }]),
      ],
    });
    const result = await listShifts(db, { orgId: "o1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [slot, held, open] = result.data;
    expect(slot?.member).toBeNull();
    expect(slot?.agencySlot).toEqual({ engagementId: "eng", accountName: "Crestline Staffing" });
    expect(held?.member).toMatchObject({
      personId: "p1",
      name: "Stella Okafor",
      rosterEntryId: "re1",
    });
    expect(held?.agencySlot).toBeNull();
    expect(open?.member).toBeNull();
    expect(open?.agencySlot).toBeNull();
    expect(calls.map((c) => c.target)).toEqual([
      "from:shifts",
      "from:roster_entry_people",
      "from:engagement_board",
    ]);
  });

  it("reads no names when no shift needs one, and filters open shifts on every worker column", async () => {
    const { db, calls } = fakeClient({ "from:shifts": [okResponse([])] });
    expect((await listShifts(db, { orgId: "o1", open: true })).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.steps.filter(([m]) => m === "is").map(([, a]) => a[0])).toEqual([
      "deleted_at",
      "membership_id",
      "engagement_id",
      "roster_entry_id",
    ]);
  });

  it("lists the agency engagements of a project", async () => {
    const { db } = fakeClient({
      "from:engagement_board": [
        okResponse([
          { engagement_id: "eng", account_name: "Crestline Staffing", engagement_state: "Active" },
          { engagement_id: null, account_name: "Hidden", engagement_state: null },
        ]),
        errorResponse("42501", "denied"),
      ],
    });
    expect(await listAgencyEngagements(db, "pr1")).toEqual({
      ok: true,
      data: [{ engagementId: "eng", accountName: "Crestline Staffing", state: "Active" }],
    });
    expect((await listAgencyEngagements(db, "pr1")).ok).toBe(false);
  });

  it("lists assignable roster staff with training and conflicts", async () => {
    const { db, calls } = fakeClient({
      "from:roster_entry_people": [
        okResponse([
          {
            id: "re1",
            engagement_id: "eng",
            person_id: "p1",
            full_name: "Stella",
            party_name: "Crestline",
            role_code: null,
          },
          {
            id: "re2",
            engagement_id: "eng",
            person_id: "p2",
            full_name: "Theo",
            party_name: "Crestline",
            role_code: null,
          },
        ]),
      ],
      "rpc:roster_training_summary": [
        okResponse([{ roster_entry_id: "re2", due_count: 1, awaiting_verification: 1 }]),
      ],
      "from:shifts": [okResponse([{ id: "other", roster_entry_id: "re1" }])],
    });
    const result = await listAssignableRosterEntries(db, {
      engagementIds: ["eng"],
      window: { shiftId: "slot", startsAt: "2027-06-01T12:00:00Z", endsAt: "2027-06-01T20:00:00Z" },
    });
    expect(result.ok && result.data.map((e) => [e.name, e.training.due, e.conflict])).toEqual([
      ["Stella", 0, true],
      ["Theo", 1, false],
    ]);
    const shiftQuery = calls.find((c) => c.target === "from:shifts");
    expect(shiftQuery?.steps).toContainEqual(["neq", ["id", "slot"]]);
    expect(await listAssignableRosterEntries(db, { engagementIds: [] })).toEqual({
      ok: true,
      data: [],
    });
  });

  it("asks for no training summary without entries", async () => {
    const { db, calls } = fakeClient({});
    expect(await rosterTrainingSummary(db, [])).toEqual({ ok: true, data: new Map() });
    expect(calls).toHaveLength(0);
  });

  it("assigns and unassigns through the RPCs and passes refusals on", async () => {
    const { db, calls } = fakeClient({
      "rpc:assign_roster_shift": [okResponse("slot"), refused("roster_training_incomplete")],
      "rpc:unassign_roster_shift": [okResponse("slot")],
    });
    expect(await assignRosterShift(db, "slot", "re1")).toEqual({ ok: true, data: { id: "slot" } });
    expect(await assignRosterShift(db, "slot", "re2")).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "roster_training_incomplete" },
    });
    expect((await unassignRosterShift(db, "slot", "Needed at the gate.")).ok).toBe(true);
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_shift_id: "slot", p_roster_entry_id: "re1" }],
    ]);
    expect(calls[2]?.steps[0]).toEqual([
      "args",
      [{ p_shift_id: "slot", p_reason: "Needed at the gate." }],
    ]);
  });

  it("reads and verifies training records", async () => {
    const { db } = fakeClient({
      "from:roster_training_records": [
        okResponse([
          {
            id: "t1",
            onboarding_requirement_id: "q1",
            acknowledged_at: "2027-05-01T00:00:00Z",
            verification_outcome: null,
            verified_at: null,
            requirement: { name: "Crowd Safety", verification_method: "Reviewer" },
          },
        ]),
      ],
      "rpc:verify_roster_training": [refused("sod_roster_training")],
    });
    const records = await listRosterTrainingRecords(db, "re1");
    expect(records.ok && records.data[0]).toMatchObject({
      requirementName: "Crowd Safety",
      outcome: null,
    });
    expect(await verifyRosterTraining(db, "t1", "Passed")).toMatchObject({
      ok: false,
      error: { rule: "sod_roster_training" },
    });
  });
});

describe("supervisor punches (R12, G-126)", () => {
  it("names who punched each entry, once each", async () => {
    const { db, calls } = fakeClient({
      "from:clock_punches": [
        okResponse([
          { time_entry_id: "te1", created_by: "carol" },
          { time_entry_id: "te1", created_by: "carol" },
          { time_entry_id: "te2", created_by: "olga" },
          { time_entry_id: null, created_by: "x" },
        ]),
      ],
    });
    const result = await listSupervisorPunchers(db, ["te1", "te2", "te1"]);
    expect(result.ok && Object.fromEntries(result.data)).toEqual({ te1: ["carol"], te2: ["olga"] });
    expect(calls[0]?.steps).toContainEqual(["eq", ["source", "Supervisor"]]);
    expect(await listSupervisorPunchers(db, [])).toEqual({ ok: true, data: new Map() });
  });
});
