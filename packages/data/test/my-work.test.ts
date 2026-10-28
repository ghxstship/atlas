import { describe, expect, it } from "vitest";
import { dayBounds, dueState, groupByDueState, listMyWork } from "../src/my-work.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const ROW = {
  id: "r1",
  record_number: 7,
  record_kind: "Task",
  record_state: "In Progress",
  title: "Hang the truss",
  due_at: "2026-10-17T15:00:00Z",
  starts_at: null,
  ends_at: null,
  updated_at: "2026-10-16T10:00:00Z",
  owner_party_id: "p1",
  accountable_party_id: null,
  project: { project_key: "NWL", name: "Northwind" },
};

describe("my work", () => {
  it("reads owned, accountable and assigned records and names why each is listed", async () => {
    const { db, calls } = fakeClient({
      "from:record_assignments": [okResponse([{ record_id: "r2" }, { record_id: "r2" }])],
      "from:records": [
        okResponse([
          ROW,
          { ...ROW, id: "r2", owner_party_id: "x", accountable_party_id: "p1", project: null },
        ]),
      ],
    });
    const result = await listMyWork(db, { orgId: "o1", personId: "p1", membershipId: "m1" });
    expect(result.ok && result.data.map((r) => [r.key, r.roles, r.ownerId])).toEqual([
      ["NWL-7", ["owner"], "p1"],
      ["-7", ["accountable", "assigned"], "x"],
    ]);
    const or = calls[1]?.steps.find((s) => s[0] === "or");
    expect(or?.[1][0]).toBe("owner_party_id.eq.p1,accountable_party_id.eq.p1,id.in.(r2)");
  });

  it("skips assignments without a membership and returns errors typed", async () => {
    const { db, calls } = fakeClient({
      "from:records": [okResponse([]), errorResponse("42501", "no")],
      "from:record_assignments": [errorResponse("42501", "no")],
    });
    const empty = await listMyWork(db, { orgId: "o1", personId: "p1", membershipId: null });
    expect(empty).toEqual({ ok: true, data: [] });
    expect(calls.map((c) => c.target)).toEqual(["from:records"]);
    expect((await listMyWork(db, { orgId: "o1", personId: "p1", membershipId: null })).ok).toBe(
      false,
    );
    expect((await listMyWork(db, { orgId: "o1", personId: "p1", membershipId: "m1" })).ok).toBe(
      false,
    );
  });

  it("bounds the day in the person's time zone, across daylight saving changes", () => {
    const ny = dayBounds(new Date("2026-10-17T03:00:00Z"), "America/New_York");
    expect(ny.start.toISOString()).toBe("2026-10-16T04:00:00.000Z");
    expect(ny.end.toISOString()).toBe("2026-10-17T04:00:00.000Z");
    const fallBack = dayBounds(new Date("2026-11-01T12:00:00Z"), "America/New_York");
    expect(fallBack.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fallBack.end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    const utc = dayBounds(new Date("2026-10-17T23:59:00Z"), "UTC");
    expect(utc.start.toISOString()).toBe("2026-10-17T00:00:00.000Z");
  });

  it("sorts records into overdue, today, upcoming and undated", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const day = dayBounds(now, "UTC");
    const none = { dueAt: null, startsAt: null, endsAt: null };
    expect(dueState({ ...none, dueAt: "2026-10-17T11:00:00Z" }, now, day)).toBe("overdue");
    expect(dueState({ ...none, endsAt: "2026-10-17T18:00:00Z" }, now, day)).toBe("today");
    expect(dueState({ ...none, startsAt: "2026-10-16T08:00:00Z" }, now, day)).toBe("today");
    expect(dueState({ ...none, startsAt: "2026-10-20T08:00:00Z" }, now, day)).toBe("upcoming");
    expect(dueState({ ...none, dueAt: "2026-10-18T00:00:00Z" }, now, day)).toBe("upcoming");
    expect(dueState(none, now, day)).toBe("undated");
    const record = {
      id: "r",
      key: "NWL-1",
      title: "t",
      kind: "Task",
      state: "Planned",
      projectKey: "NWL",
      projectName: "N",
      updatedAt: "",
      roles: [],
      ownerId: null,
      ...none,
    };
    const groups = groupByDueState(
      [record, { ...record, id: "o", dueAt: "2026-10-01T00:00:00Z" }],
      now,
      "UTC",
    );
    expect(groups.map((g) => [g.state, g.records.map((r) => r.id)])).toEqual([
      ["overdue", ["o"]],
      ["today", []],
      ["upcoming", []],
      ["undated", ["r"]],
    ]);
  });
});
