import { describe, expect, it } from "vitest";
import {
  assignRecordToPosition,
  fillPosition,
  listBreakTypes,
  listPositions,
  retirePosition,
  saveBreakType,
  savePosition,
  setDefaultBreakType,
  unassignRecordFromPosition,
  vacatePosition,
} from "../src/crew.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/** Project positions and break types (B9, migrations 2984 and 2985, ADR 0148). */

const argsOf = (call: { steps: [string, unknown[]][] } | undefined) =>
  call?.steps.find((step) => step[0] === "args")?.[1][0];

describe("positions", () => {
  it("lists positions with holders, agencies and counts", async () => {
    const { db } = fakeClient({
      "from:project_positions": [
        okResponse([
          {
            id: "pos2",
            project_id: "p1",
            title: "Stage Manager",
            role_code: null,
            engagement_id: null,
            membership_id: "m1",
            roster_entry_id: null,
            filled_at: "2027-01-01T00:00:00Z",
            project: { project_key: "NWL", name: "Pier" },
          },
          {
            id: "pos1",
            project_id: "p1",
            title: "Crowd Lead",
            role_code: "0000.50.01",
            engagement_id: "e1",
            membership_id: null,
            roster_entry_id: "r1",
            filled_at: "2027-01-02T00:00:00Z",
            project: { project_key: "NWL", name: "Pier" },
          },
        ]),
      ],
      "from:shifts": [okResponse([{ project_position_id: "pos1" }, { project_position_id: "pos1" }])],
      "from:record_position_assignments": [okResponse([{ project_position_id: "pos2" }])],
      "from:memberships": [okResponse([{ id: "m1", person_id: "x1" }])],
      "rpc:person_names": [okResponse([{ person_id: "x1", full_name: "Frank Adeyemi" }])],
      "from:roster_entry_people": [okResponse([{ id: "r1", full_name: "Stella Okafor" }])],
      "from:engagement_board": [okResponse([{ engagement_id: "e1", account_name: "Crestline" }])],
    });
    const result = await listPositions(db, { orgId: "o1" });
    expect(result.ok && result.data.map((p) => p.title)).toEqual(["Crowd Lead", "Stage Manager"]);
    expect(result.ok && result.data[0]).toMatchObject({
      agencyName: "Crestline",
      holder: { rosterEntryId: "r1", name: "Stella Okafor" },
      shiftCount: 2,
      recordCount: 0,
    });
    expect(result.ok && result.data[1]).toMatchObject({
      holder: { membershipId: "m1", name: "Frank Adeyemi" },
      recordCount: 1,
    });
  });

  it("reads nothing more when there are none", async () => {
    const { db, calls } = fakeClient({ "from:project_positions": [okResponse([])] });
    const result = await listPositions(db, { orgId: "o1", projectId: "p1" });
    expect(result).toEqual({ ok: true, data: [] });
    expect(calls).toHaveLength(1);
  });

  it("creates, then updates only the columns a caller may change", async () => {
    const { db, calls } = fakeClient({
      "from:project_positions": [okResponse({ id: "pos1" }), okResponse([{ id: "pos1" }])],
    });
    await savePosition(db, "o1", {
      projectId: "p1",
      title: "  Rigger 2 ",
      roleCode: null,
      engagementId: null,
    });
    await savePosition(db, "o1", {
      id: "pos1",
      projectId: "p1",
      title: "Rigger 3",
      roleCode: null,
      engagementId: "e1",
    });
    expect(calls[0]?.steps.find((s) => s[0] === "insert")?.[1][0]).toEqual({
      org_id: "o1",
      project_id: "p1",
      title: "Rigger 2",
      role_code: null,
      engagement_id: null,
    });
    expect(calls[1]?.steps.find((s) => s[0] === "update")?.[1][0]).toEqual({
      title: "Rigger 3",
      role_code: null,
      engagement_id: "e1",
    });
  });

  it("fills with one holder and reads what filling did", async () => {
    const { db, calls } = fakeClient({
      "rpc:fill_position": [
        okResponse({
          position_id: "pos1",
          shifts_filled: 2,
          shifts_skipped: [{ shift_id: "s3", code: "shift_double_booked" }],
          records_resolved: 1,
          policy_warnings: [{ shift_id: "s1", code: "shift_day_over" }],
        }),
      ],
    });
    const result = await fillPosition(db, "pos1", { membershipId: "m1" });
    expect(argsOf(calls[0])).toEqual({ p_position_id: "pos1", p_membership_id: "m1" });
    expect(result).toEqual({
      ok: true,
      data: {
        shiftsFilled: 2,
        shiftsSkipped: [{ shiftId: "s3", code: "shift_double_booked" }],
        recordsResolved: 1,
        policyWarnings: [{ shiftId: "s1", code: "shift_day_over" }],
      },
    });
  });

  it("vacates with a reason", async () => {
    const { db, calls } = fakeClient({
      "rpc:vacate_position": [okResponse({ shifts_returned: 2, records_unassigned: 1 })],
    });
    const result = await vacatePosition(db, "pos1", "Moved on.");
    expect(argsOf(calls[0])).toEqual({ p_position_id: "pos1", p_reason: "Moved on." });
    expect(result).toEqual({ ok: true, data: { shiftsReturned: 2, recordsUnassigned: 1 } });
  });

  it("moves to Trash, and takes a record on and off", async () => {
    const { db, calls } = fakeClient({
      "from:project_positions": [okResponse([{ id: "pos1" }])],
      "from:record_position_assignments": [okResponse({ id: "a1" }), okResponse([{ id: "a1" }])],
    });
    expect((await retirePosition(db, "pos1", new Date("2027-01-01T00:00:00Z"))).ok).toBe(true);
    expect(await assignRecordToPosition(db, "o1", "r1", "pos1")).toEqual({
      ok: true,
      data: { id: "a1" },
    });
    expect((await unassignRecordFromPosition(db, "a1", new Date("2027-01-01T00:00:00Z"))).ok).toBe(
      true,
    );
    expect(calls[2]?.steps.find((s) => s[0] === "update")?.[1][0]).toEqual({
      deleted_at: "2027-01-01T00:00:00.000Z",
    });
  });
});

describe("break types", () => {
  it("lists, saves and picks a default", async () => {
    const { db, calls } = fakeClient({
      "from:break_types": [
        okResponse([{ id: "b1", name: "Meal", paid: false, planned_minutes: 30, is_default: true }]),
        okResponse({ id: "b2" }),
      ],
      "rpc:set_default_break_type": [okResponse("b2")],
    });
    const listed = await listBreakTypes(db, "o1");
    expect(listed.ok && listed.data[0]).toEqual({
      id: "b1",
      name: "Meal",
      paid: false,
      plannedMinutes: 30,
      isDefault: true,
    });
    await saveBreakType(db, "o1", { name: " Rest ", paid: true, plannedMinutes: null });
    expect(calls[1]?.steps.find((s) => s[0] === "insert")?.[1][0]).toEqual({
      org_id: "o1",
      name: "Rest",
      paid: true,
      planned_minutes: null,
    });
    expect((await setDefaultBreakType(db, "b2")).ok).toBe(true);
  });
});
