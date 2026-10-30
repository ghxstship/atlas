import { describe, expect, it } from "vitest";
import {
  addDays,
  addDependency,
  buildTimeline,
  calendarEvents,
  computeVariance,
  createBaseline,
  dayDiff,
  getActual,
  getBaselineVariance,
  intervalHours,
  latestBaselinePlan,
  listBaselines,
  listDependencies,
  localDay,
  lockBaseline,
  lockedRecordIds,
  recordWindow,
  removeDependency,
  placeRecord,
  rescheduleRecord,
  scheduleWindow,
  setActual,
  shiftRecords,
  shiftUndoRows,
  updateBaseline,
} from "../src/schedule.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";
import { recordRow, summary } from "./records-fixture.ts";

const NOW = new Date("2027-06-02T12:00:00Z");

describe("dependencies", () => {
  it("lists, adds and removes dependencies", async () => {
    const { db, calls } = moduleClient({
      "from:record_dependencies": [
        okResponse([
          {
            id: "d1",
            predecessor_record_id: "a",
            successor_record_id: "b",
            dependency_type: "Finish to Start",
            lag: "00:00:00",
          },
        ]),
        okResponse({ id: "d2" }),
        okResponse({ id: "d3" }),
        okResponse([{ id: "d2" }]),
        okResponse([]),
      ],
    });
    expect(await listDependencies(db, [])).toEqual({ ok: true, data: [] });
    const list = await listDependencies(db, ["a", "b"]);
    expect(list.ok && list.data[0]?.successorId).toBe("b");
    expect(stepsOf(calls[0], "or")).toEqual([
      ["predecessor_record_id.in.(a,b),successor_record_id.in.(a,b)"],
    ]);
    expect(await addDependency(db, { orgId: "o1", predecessorId: "a", successorId: "b" })).toEqual({
      ok: true,
      data: { id: "d2" },
    });
    expect(stepsOf(calls[1], "insert")[0]?.[0]).toMatchObject({
      dependency_type: "Finish to Start",
      lag: "0 minutes",
    });
    await addDependency(db, {
      orgId: "o1",
      predecessorId: "a",
      successorId: "c",
      type: "Start to Start",
      lagMinutes: -30,
    });
    expect(stepsOf(calls[2], "insert")[0]?.[0]).toMatchObject({
      dependency_type: "Start to Start",
      lag: "-30 minutes",
    });
    expect((await removeDependency(db, "d2")).ok).toBe(true);
    expect(await removeDependency(db, "d2")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("surfaces dependency refusals", async () => {
    const { db } = moduleClient({
      "from:record_dependencies": [
        errorResponse("XX000", "boom"),
        errorResponse("XR001", "dependency_cycle: circular", "dependency_cycle"),
        errorResponse("XX000", "boom"),
      ],
    });
    expect((await listDependencies(db, ["a"])).ok).toBe(false);
    expect(await addDependency(db, { orgId: "o1", predecessorId: "a", successorId: "b" })).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "dependency_cycle", message: "circular" },
    });
    expect((await removeDependency(db, "d")).ok).toBe(false);
  });
});

describe("timeline", () => {
  it("finds a record's window", () => {
    expect(recordWindow(summary())).toBeNull();
    expect(recordWindow(summary({ due_at: "2027-06-03T00:00:00Z" }))).toEqual({
      start: "2027-06-03T00:00:00Z",
      end: "2027-06-03T00:00:00Z",
    });
    expect(
      recordWindow(summary({ starts_at: "2027-06-05T00:00:00Z", ends_at: "2027-06-04T00:00:00Z" })),
    ).toEqual({
      start: "2027-06-04T00:00:00Z",
      end: "2027-06-05T00:00:00Z",
    });
  });

  it("does day arithmetic in a time zone", () => {
    expect(localDay("2027-06-02T02:00:00Z", "America/New_York")).toBe("2027-06-01");
    expect(localDay(new Date("2027-06-02T02:00:00Z"), "UTC")).toBe("2027-06-02");
    expect(dayDiff("2027-06-01", "2027-06-04")).toBe(3);
    expect(addDays("2027-06-30", 2)).toBe("2027-07-02");
  });

  it("lays out bars, arrows, baselines and today", () => {
    const a = summary({
      id: "a",
      starts_at: "2027-06-01T14:00:00Z",
      ends_at: "2027-06-02T20:00:00Z",
    });
    const b = summary({
      id: "b",
      record_number: 8,
      starts_at: "2027-06-03T14:00:00Z",
      ends_at: "2027-06-04T20:00:00Z",
    });
    const m = summary({
      id: "m",
      record_number: 9,
      record_kind: "Milestone",
      due_at: "2027-06-05T16:00:00Z",
    });
    const undated = summary({ id: "u", record_number: 10 });
    const model = buildTimeline({
      records: [b, a, m, undated],
      dependencies: [
        { id: "d", predecessorId: "a", successorId: "b", type: "Finish to Start", lag: "0" },
      ],
      baseline: new Map([
        ["b", { start: "2027-06-02T14:00:00Z", end: "2027-06-03T20:00:00Z" }],
        ["m", { start: null, end: "2027-06-04T16:00:00Z" }],
      ]),
      timeZone: "America/New_York",
      now: NOW,
    });
    expect(model.days[0]?.day).toBe("2027-05-31");
    expect(model.days).toHaveLength(7);
    expect(model.bars.map((bar) => bar.record.id)).toEqual(["a", "b", "m"]);
    expect(model.bars[0]).toMatchObject({ start: 1, end: 2, milestone: false });
    expect(model.bars[1]).toMatchObject({ dependsOn: 0, baselineStart: 2, baselineEnd: 3 });
    expect(model.bars[2]).toMatchObject({ milestone: true, baselineStart: 4, baselineEnd: 4 });
    expect(model.edges).toEqual([{ from: 0, to: 1, type: "Finish to Start", lagHours: 0 }]);
    expect(model.today).toBe(2);
    expect(model.days.filter((d) => d.weekend).map((d) => d.day)).toEqual([
      "2027-06-05",
      "2027-06-06",
    ]);
  });

  it("is empty without dated records and caps its length", () => {
    expect(buildTimeline({ records: [summary()], timeZone: "UTC" })).toEqual({
      days: [],
      bars: [],
    });
    const long = buildTimeline({
      records: [summary({ starts_at: "2027-01-01T00:00:00Z", ends_at: "2027-12-31T00:00:00Z" })],
      timeZone: "UTC",
      maxDays: 30,
      pad: 0,
      now: new Date("2020-01-01T00:00:00Z"),
    });
    expect(long.days).toHaveLength(30);
    expect(long.bars[0]?.end).toBe(29);
    expect(long.today).toBeUndefined();
  });

  it("spreads records across calendar days", () => {
    const events = calendarEvents(
      [
        summary({ id: "a", starts_at: "2027-06-01T12:00:00Z", ends_at: "2027-06-03T12:00:00Z" }),
        summary({ id: "b", due_at: "2027-06-02T12:00:00Z" }),
        summary({ id: "c" }),
      ],
      "UTC",
    );
    expect(events.map((e) => `${e.date}:${e.record.id}`)).toEqual([
      "2027-06-01:a",
      "2027-06-02:a",
      "2027-06-02:b",
      "2027-06-03:a",
    ]);
  });
});

describe("baselines", () => {
  it("lists baselines with item counts", async () => {
    const { db, calls } = moduleClient({
      "from:schedule_baselines": [
        okResponse([
          {
            id: "b1",
            project_id: "p1",
            name: "Gate 3 Baseline",
            locked_at: null,
            created_at: "t",
            project: { project_key: "NWL" },
            items: [{ count: 4 }],
          },
          {
            id: "b2",
            project_id: "p1",
            name: "Draft",
            locked_at: null,
            created_at: "t",
            project: null,
            items: null,
          },
        ]),
        errorResponse("XX000", "boom"),
      ],
    });
    const list = await listBaselines(db, { orgId: "o1", projectId: "p1" });
    expect(list.ok && list.data.map((b) => [b.projectKey, b.itemCount])).toEqual([
      ["NWL", 4],
      ["", 0],
    ]);
    expect(stepsOf(calls[0], "eq")).toContainEqual(["project_id", "p1"]);
    expect((await listBaselines(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("creates, locks, renames and deletes baselines", async () => {
    const { db, calls } = moduleClient({
      "from:schedule_baselines": [
        okResponse({ id: "b1" }),
        errorResponse("XX000", "boom"),
        okResponse([{ id: "b1" }]),
        okResponse([]),
        errorResponse("XR001", "baseline_locked: never", "baseline_locked"),
      ],
      "rpc:lock_baseline": [
        okResponse(5),
        okResponse(null),
        errorResponse("XR001", "baseline_locked: again", "baseline_locked"),
      ],
    });
    expect(await createBaseline(db, { orgId: "o1", projectId: "p1", name: " Gate 3 " })).toEqual({
      ok: true,
      data: { id: "b1" },
    });
    expect(stepsOf(calls[0], "insert")[0]?.[0]).toMatchObject({ name: "Gate 3" });
    expect((await createBaseline(db, { orgId: "o1", projectId: "p1", name: "x" })).ok).toBe(false);
    expect(await lockBaseline(db, "b1")).toEqual({ ok: true, data: { captured: 5 } });
    expect(await lockBaseline(db, "b1")).toEqual({ ok: true, data: { captured: 0 } });
    expect((await lockBaseline(db, "b1")).ok).toBe(false);
    expect((await updateBaseline(db, "b1", { name: " New ", deleted: true })).ok).toBe(true);
    expect(stepsOf(calls[5], "update")[0]?.[0]).toMatchObject({ name: "New" });
    expect(await updateBaseline(db, "b1", { name: "x" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await updateBaseline(db, "b1", { deleted: true })).ok).toBe(false);
  });

  it("derives variance from planned and current dates", () => {
    const late = summary({
      id: "a",
      starts_at: "2027-06-02T00:00:00Z",
      ends_at: "2027-06-04T00:00:00Z",
    });
    const undated = summary({ id: "b" });
    const variance = computeVariance(
      [
        { recordId: "a", plannedStart: "2027-06-01T00:00:00Z", plannedEnd: "2027-06-03T00:00:00Z" },
        { recordId: "b", plannedStart: null, plannedEnd: "2027-06-03T00:00:00Z" },
        { recordId: "gone", plannedStart: null, plannedEnd: null },
      ],
      [late, undated],
    );
    expect(variance.map((v) => [v.record.id, v.startSlipMs, v.endSlipMs])).toEqual([
      ["a", 86_400_000, 86_400_000],
      ["b", null, null],
    ]);
  });

  it("reads one baseline against current dates", async () => {
    const baseline = {
      id: "b1",
      project_id: "p1",
      name: "Gate 3",
      locked_at: "t",
      created_at: "t",
      project: { project_key: "NWL" },
      items: [
        { record_id: "r1", planned_starts_at: null, planned_ends_at: "2027-06-01T00:00:00Z" },
      ],
    };
    const { db } = moduleClient({
      "from:schedule_baselines": [
        okResponse(baseline),
        okResponse({ ...baseline, project: null, items: null }),
        okResponse(null),
        errorResponse("XX000", "boom"),
        okResponse(baseline),
      ],
      "from:records": [
        okResponse([recordRow({ due_at: "2027-06-02T00:00:00Z" })]),
        errorResponse("XX000", "boom"),
      ],
    });
    const result = await getBaselineVariance(db, "o1", "b1");
    expect(result.ok && result.data.variance[0]?.endSlipMs).toBe(86_400_000);
    const empty = await getBaselineVariance(db, "o1", "b1");
    expect(empty.ok && empty.data.baseline.itemCount).toBe(0);
    expect(await getBaselineVariance(db, "o1", "b1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getBaselineVariance(db, "o1", "b1")).ok).toBe(false);
    expect((await getBaselineVariance(db, "o1", "b1")).ok).toBe(false);
  });

  it("reads the latest locked plan of a project", async () => {
    const { db } = moduleClient({
      "from:schedule_baselines": [
        okResponse({
          id: "b1",
          items: [{ record_id: "r1", planned_starts_at: "s", planned_ends_at: "e" }],
        }),
        okResponse(null),
        errorResponse("XX000", "boom"),
      ],
    });
    const plan = await latestBaselinePlan(db, "p1");
    expect(plan.ok && plan.data.get("r1")).toEqual({ start: "s", end: "e" });
    const none = await latestBaselinePlan(db, "p1");
    expect(none.ok && none.data.size).toBe(0);
    expect((await latestBaselinePlan(db, "p1")).ok).toBe(false);
  });
});

describe("actuals", () => {
  it("reads, inserts and updates actuals", async () => {
    const { db, calls } = moduleClient({
      "from:schedule_actuals": [
        okResponse({ record_id: "r1", actual_starts_at: "s", actual_ends_at: null }),
        okResponse(null),
        okResponse(null),
        okResponse({ record_id: "r1", actual_starts_at: "s", actual_ends_at: null }),
        okResponse(null),
        errorResponse("XX000", "boom"),
      ],
    });
    expect(await getActual(db, "r1")).toEqual({
      ok: true,
      data: { recordId: "r1", startedAt: "s", finishedAt: null },
    });
    expect(
      (await setActual(db, { orgId: "o1", recordId: "r1", startedAt: "s", finishedAt: null })).ok,
    ).toBe(true);
    expect(stepsOf(calls[2], "insert")).toHaveLength(1);
    expect(
      (await setActual(db, { orgId: "o1", recordId: "r1", startedAt: "s", finishedAt: "f" })).ok,
    ).toBe(true);
    expect(stepsOf(calls[4], "update")[0]?.[0]).toEqual({
      actual_starts_at: "s",
      actual_ends_at: "f",
    });
    expect(
      (await setActual(db, { orgId: "o1", recordId: "r1", startedAt: null, finishedAt: null })).ok,
    ).toBe(false);
  });
});

describe("reschedule", () => {
  it("reads interval lag in hours", () => {
    expect(intervalHours("00:00:00")).toBe(0);
    expect(intervalHours("02:30:00")).toBe(2.5);
    expect(intervalHours("1 day")).toBe(24);
    expect(intervalHours("-1 days")).toBe(-24);
    expect(intervalHours("2 days 06:00:00")).toBe(54);
    expect(intervalHours("-01:00:00")).toBe(-1);
  });

  it("marks locked bars and keeps only edges between drawn bars", () => {
    const a = summary({
      id: "a",
      starts_at: "2027-06-01T12:00:00Z",
      ends_at: "2027-06-01T20:00:00Z",
    });
    const b = summary({
      id: "b",
      starts_at: "2027-06-03T12:00:00Z",
      ends_at: "2027-06-03T20:00:00Z",
    });
    const model = buildTimeline({
      records: [a, b],
      dependencies: [
        { id: "d1", predecessorId: "a", successorId: "b", type: "Start to Start", lag: "1 day" },
        { id: "d2", predecessorId: "b", successorId: "hidden", type: "Finish to Start", lag: "0" },
      ],
      locked: new Set(["b"]),
      timeZone: "UTC",
      now: NOW,
    });
    expect(model.bars[1]?.locked).toBe(true);
    expect(model.bars[0]?.locked).toBeUndefined();
    expect(model.edges).toEqual([{ from: 0, to: 1, type: "Start to Start", lagHours: 24 }]);
  });

  it("previews and commits through app.reschedule_record", async () => {
    const row = {
      record_id: "a",
      is_target: true,
      shift_start_days: 1,
      shift_end_days: 1,
      starts_at: "2027-06-02T12:00:00Z",
      ends_at: "2027-06-02T20:00:00Z",
      due_at: null,
      old_starts_at: "2027-06-01T12:00:00Z",
      old_ends_at: "2027-06-01T20:00:00Z",
      old_due_at: null,
      baseline_starts_at: null,
      baseline_ends_at: null,
    };
    const { db, calls } = moduleClient({
      "rpc:reschedule_record": [
        okResponse([row]),
        okResponse([row]),
        errorResponse(
          "XR001",
          "reschedule_locked: NWL-4 Load-In Window is locked.",
          "reschedule_locked",
        ),
      ],
    });
    const preview = await rescheduleRecord(db, { recordId: "a", startDays: 1, endDays: 1 });
    expect(preview).toEqual({
      ok: true,
      data: [
        {
          recordId: "a",
          isTarget: true,
          shiftStartDays: 1,
          shiftEndDays: 1,
          shiftStartMinutes: 0,
          shiftEndMinutes: 0,
          startsAt: "2027-06-02T12:00:00Z",
          endsAt: "2027-06-02T20:00:00Z",
          dueAt: null,
          oldStartsAt: "2027-06-01T12:00:00Z",
          oldEndsAt: "2027-06-01T20:00:00Z",
          oldDueAt: null,
          baselineStartsAt: null,
          baselineEndsAt: null,
        },
      ],
    });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_record_id: "a",
      p_start_days: 1,
      p_end_days: 1,
      p_commit: false,
    });
    await rescheduleRecord(db, {
      recordId: "a",
      startDays: 1,
      endDays: 1,
      commit: true,
      reason: "Truss arrives a day late.",
    });
    expect(stepsOf(calls[1], "args")[0]?.[0]).toMatchObject({
      p_commit: true,
      p_reason: "Truss arrives a day late.",
    });
    const refused = await rescheduleRecord(db, { recordId: "a", startDays: 9, endDays: 9 });
    expect(refused.ok === false && refused.error).toMatchObject({
      kind: "refusal",
      rule: "reschedule_locked",
    });
  });

  it("finds complete records and Timeline windows locked into a baseline", async () => {
    const { db, calls } = moduleClient({
      "from:record_timeline": [okResponse([{ record_id: "w" }]), errorResponse("XX000", "boom")],
    });
    const records = [
      summary({ id: "done", record_state: "Complete" }),
      summary({ id: "w", record_kind: "Timeline", record_subtype: "Show Cycle" }),
      summary({ id: "open" }),
    ];
    const locked = await lockedRecordIds(db, records);
    expect(locked.ok && [...locked.data].sort()).toEqual(["done", "w"]);
    expect(stepsOf(calls[0], "in")).toEqual([["record_id", ["w"]]]);
    expect((await lockedRecordIds(db, [summary({ id: "open" })])).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect((await lockedRecordIds(db, records)).ok).toBe(false);
  });
});

describe("minute shifts, placements and their undo (P8)", () => {
  const move = {
    record_id: "a",
    is_target: true,
    shift_start_days: 0,
    shift_end_days: 0,
    shift_start_minutes: 30,
    shift_end_minutes: 30,
    starts_at: "2027-06-01T12:30:00+00:00",
    ends_at: "2027-06-01T20:30:00+00:00",
    due_at: null,
    old_starts_at: "2027-06-01T12:00:00+00:00",
    old_ends_at: "2027-06-01T20:00:00+00:00",
    old_due_at: null,
    baseline_starts_at: null,
    baseline_ends_at: null,
  };

  it("sends minute offsets only when they are set, and reads the minutes each row moves", async () => {
    const { db, calls } = moduleClient({
      "rpc:reschedule_record": [okResponse([move]), okResponse([])],
    });
    const preview = await rescheduleRecord(db, {
      recordId: "a",
      startDays: 0,
      endDays: 0,
      startMinutes: 30,
      endMinutes: 30,
    });
    expect(preview.ok && preview.data[0]).toMatchObject({
      shiftStartMinutes: 30,
      shiftEndMinutes: 30,
      startsAt: "2027-06-01T12:30:00+00:00",
    });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_record_id: "a",
      p_start_days: 0,
      p_end_days: 0,
      p_commit: false,
      p_start_minutes: 30,
      p_end_minutes: 30,
    });
    await rescheduleRecord(db, { recordId: "a", startDays: 1, endDays: 1, startMinutes: 0 });
    expect(stepsOf(calls[1], "args")[0]?.[0]).not.toHaveProperty("p_start_minutes");
  });

  it("shifts a selection, with each moved record's project", async () => {
    const { db, calls } = moduleClient({
      "rpc:shift_records": [
        okResponse([
          { ...move, shift_start_minutes: null, shift_end_minutes: null, project_id: "p" },
        ]),
        errorResponse(
          "XR001",
          "shift_too_large: Shift at most 500 records at a time.",
          "shift_too_large",
        ),
      ],
    });
    const shifted = await shiftRecords(db, {
      recordIds: ["a", "b"],
      minutes: 15,
      commit: true,
      reason: "Doors open late.",
    });
    expect(shifted.ok && shifted.data[0]).toMatchObject({
      projectId: "p",
      shiftStartMinutes: 0,
      shiftEndMinutes: 0,
    });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_record_ids: ["a", "b"],
      p_minutes: 15,
      p_commit: true,
      p_reason: "Doors open late.",
    });
    const refused = await shiftRecords(db, { recordIds: ["a"], minutes: 15 });
    expect(refused.ok === false && refused.error).toMatchObject({ rule: "shift_too_large" });
  });

  it("places an undated record on a day", async () => {
    const placed = { ...move, old_starts_at: null, old_ends_at: null };
    const { db, calls } = moduleClient({
      "rpc:place_record": [
        okResponse([placed]),
        errorResponse("XR001", "place_dated: This record already has dates.", "place_dated"),
      ],
    });
    const result = await placeRecord(db, { recordId: "a", day: "2027-06-01" });
    expect(result.ok && result.data[0]?.oldStartsAt).toBeNull();
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_record_id: "a",
      p_day: "2027-06-01",
      p_commit: false,
    });
    const refused = await placeRecord(db, {
      recordId: "a",
      day: "2027-06-01",
      commit: true,
      reason: "Placed.",
    });
    expect(refused.ok === false && refused.error).toMatchObject({ rule: "place_dated" });
    expect(stepsOf(calls[1], "args")[0]?.[0]).toMatchObject({
      p_commit: true,
      p_reason: "Placed.",
    });
  });

  it("undoes a move by setting the old dates back, expecting the new, null included", () => {
    const moved = {
      recordId: "a",
      isTarget: true,
      shiftStartDays: 0,
      shiftEndDays: 0,
      shiftStartMinutes: 0,
      shiftEndMinutes: 0,
      startsAt: "2027-06-01T13:00:00+00:00",
      endsAt: "2027-06-01T21:00:00+00:00",
      dueAt: null,
      oldStartsAt: null,
      oldEndsAt: null,
      oldDueAt: null,
      baselineStartsAt: null,
      baselineEndsAt: null,
    };
    const still = { ...moved, recordId: "b", startsAt: null, endsAt: null };
    expect(shiftUndoRows([moved, still])).toEqual([
      {
        id: "a",
        set: { starts_at: null, ends_at: null, due_at: null },
        expect: {
          starts_at: "2027-06-01T13:00:00+00:00",
          ends_at: "2027-06-01T21:00:00+00:00",
          due_at: null,
        },
      },
    ]);
  });

  it("draws a window of days when nothing is dated", async () => {
    const empty = buildTimeline({ records: [], timeZone: "America/New_York", now: NOW });
    expect(empty.days).toHaveLength(0);
    const drawn = buildTimeline({
      records: [],
      timeZone: "America/New_York",
      now: NOW,
      window: { first: "2027-06-01", last: "2027-06-28" },
    });
    expect(drawn.days).toHaveLength(28);
    expect(drawn.days[0]?.day).toBe("2027-06-01");
    expect(drawn.today).toBe(1);
    expect(drawn.bars).toEqual([]);

    const { db } = moduleClient({
      "from:projects": [
        okResponse({ starts_on: "2027-07-01", ends_on: "2027-07-04" }),
        okResponse({ starts_on: null, ends_on: null }),
        errorResponse("XX000", "boom"),
      ],
    });
    expect(await scheduleWindow(db, undefined, "2027-06-02")).toEqual({
      ok: true,
      data: { first: "2027-06-02", last: "2027-06-29" },
    });
    expect(await scheduleWindow(db, "p", "2027-06-02")).toEqual({
      ok: true,
      data: { first: "2027-07-01", last: "2027-07-04" },
    });
    expect((await scheduleWindow(db, "p", "2027-06-02")).ok && true).toBe(true);
    expect((await scheduleWindow(db, "p", "2027-06-02")).ok).toBe(false);
  });
});
