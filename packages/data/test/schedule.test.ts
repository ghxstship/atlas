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
  latestBaselinePlan,
  listBaselines,
  listDependencies,
  localDay,
  lockBaseline,
  recordWindow,
  removeDependency,
  setActual,
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
    const { db, calls } = moduleClient({
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
    // An archived record stays in its baseline's variance (A124).
    expect(
      stepsOf(
        calls.find((c) => c.target === "from:records"),
        "is",
      ),
    ).toEqual([["deleted_at", null]]);
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
