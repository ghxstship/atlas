import { describe, expect, it } from "vitest";
import {
  addCue,
  callCue,
  createCallSheet,
  createRunOfShow,
  cueProgress,
  deleteRunOfShow,
  deleteSheet,
  getRunOfShow,
  intervalSeconds,
  linkCueToEngagement,
  listCallSheets,
  listCalls,
  listCueEngagements,
  listCueCalls,
  listCues,
  listDaySheets,
  listRunsOfShow,
  moveCue,
  moveCueTo,
  publishSheet,
  removeCue,
  restoreSheet,
  saveCueCalls,
  saveDaySheet,
  shiftCuePlan,
  standbyCue,
  unlinkCueEngagement,
  updateCue,
  updateRunOfShow,
  zonedMidnight,
  type Cue,
} from "../src/show.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const run = {
  id: "ros1",
  project_id: "p1",
  scope_node_id: null,
  name: "Opening Night",
  show_date: "2027-06-05",
  project: { project_key: "NWL", name: "Series", time_zone: "America/New_York" },
  cues: [
    { called_at: "t", deleted_at: null },
    { called_at: null, deleted_at: null },
    { called_at: "t", deleted_at: "t" },
  ],
};

const cueRow = (id: string, position: number, over: Record<string, unknown> = {}) => ({
  id,
  run_of_show_id: "ros1",
  position,
  label: `Cue ${position}`,
  planned_at: null,
  duration: null,
  called_at: null,
  caller: null,
  ...over,
});

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: "c",
  runOfShowId: "ros1",
  position: 1,
  label: "Cue",
  plannedAt: null,
  durationSeconds: null,
  calledAt: null,
  calledByName: null,
  startTbc: false,
  standbyAt: null,
  segment: null,
  description: null,
  script: null,
  segmentInstanceId: null,
  calledViaLink: null,
  updatedAt: "2027-06-05T20:00:00Z",
  ...over,
});

describe("running orders", () => {
  it("lists running orders with cue counts and filters", async () => {
    const { db, calls } = moduleClient({
      "from:run_of_show": [
        okResponse([run, { ...run, id: "ros2", project: null, cues: null }]),
        errorResponse("XX000", "b"),
      ],
    });
    const list = await listRunsOfShow(db, {
      orgId: "o1",
      projectId: "p1",
      from: "2027-06-01",
      to: "2027-06-30",
      search: "open",
    });
    expect(list.ok && list.data[0]).toMatchObject({
      projectKey: "NWL",
      cueCount: 2,
      calledCount: 1,
    });
    expect(list.ok && list.data[1]).toMatchObject({ projectKey: "", timeZone: "UTC", cueCount: 0 });
    expect(stepsOf(calls[0], "gte")).toEqual([["show_date", "2027-06-01"]]);
    expect(stepsOf(calls[0], "ilike")).toEqual([["name", "%open%"]]);
    expect((await listRunsOfShow(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("reads, creates, edits and deletes a running order", async () => {
    const { db, calls } = moduleClient({
      "from:run_of_show": [
        okResponse(run),
        okResponse(null),
        errorResponse("XX000", "b"),
        okResponse({ id: "ros9" }),
        errorResponse("XX000", "b"),
        okResponse([{ id: "ros1" }]),
        okResponse([]),
        errorResponse("XX000", "b"),
        okResponse([{ id: "ros1" }]),
        okResponse([]),
        errorResponse("XX000", "b"),
      ],
    });
    expect((await getRunOfShow(db, "ros1")).ok).toBe(true);
    expect(await getRunOfShow(db, "ros1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getRunOfShow(db, "ros1")).ok).toBe(false);
    expect(
      await createRunOfShow(db, {
        orgId: "o1",
        projectId: "p1",
        name: " Opening ",
        showDate: "2027-06-05",
      }),
    ).toEqual({
      ok: true,
      data: { id: "ros9" },
    });
    expect(stepsOf(calls[3], "insert")[0]?.[0]).toMatchObject({
      name: "Opening",
      scope_node_id: null,
    });
    expect(
      (await createRunOfShow(db, { orgId: "o1", projectId: "p1", name: "x", showDate: "x" })).ok,
    ).toBe(false);
    expect(
      (
        await updateRunOfShow(db, "ros1", {
          name: " New ",
          showDate: "2027-06-06",
          scopeNodeId: "s1",
        })
      ).ok,
    ).toBe(true);
    expect(stepsOf(calls[5], "update")[0]?.[0]).toEqual({
      name: "New",
      show_date: "2027-06-06",
      scope_node_id: "s1",
    });
    expect(await updateRunOfShow(db, "ros1", {})).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await updateRunOfShow(db, "ros1", {})).ok).toBe(false);
    expect((await deleteRunOfShow(db, "ros1")).ok).toBe(true);
    expect(await deleteRunOfShow(db, "ros1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await deleteRunOfShow(db, "ros1")).ok).toBe(false);
  });
});

describe("cues", () => {
  it("reads interval text as seconds", () => {
    expect(intervalSeconds(null)).toBeNull();
    expect(intervalSeconds("00:01:30")).toBe(90);
    expect(intervalSeconds("1 day 02:00:00")).toBe(93_600);
    expect(intervalSeconds("-00:00:10")).toBe(-10);
    expect(intervalSeconds("soon")).toBeNull();
  });

  it("lists cues and adds one at the end", async () => {
    const { db, calls } = moduleClient({
      "from:cues": [
        okResponse([
          cueRow("c1", 1, { duration: "00:00:45", caller: { full_name: "Sam" }, called_at: "t" }),
        ]),
        okResponse([cueRow("c1", 1)]),
        okResponse({ id: "c2" }),
        okResponse([]),
        okResponse({ id: "c3" }),
        errorResponse("XX000", "b"),
        okResponse([]),
        errorResponse("XX000", "b"),
      ],
    });
    const list = await listCues(db, "ros1");
    expect(list.ok && list.data[0]).toMatchObject({ durationSeconds: 45, calledByName: "Sam" });
    expect(
      await addCue(db, {
        orgId: "o1",
        projectId: "p1",
        runOfShowId: "ros1",
        label: " Lights ",
        durationSeconds: 30,
      }),
    ).toEqual({
      ok: true,
      data: { id: "c2" },
    });
    expect(stepsOf(calls[2], "insert")[0]?.[0]).toMatchObject({
      position: 2,
      label: "Lights",
      duration: "30 seconds",
    });
    await addCue(db, { orgId: "o1", projectId: "p1", runOfShowId: "ros1", label: "Doors" });
    expect(stepsOf(calls[4], "insert")[0]?.[0]).toMatchObject({
      position: 1,
      duration: null,
      planned_at: null,
    });
    expect(
      (await addCue(db, { orgId: "o1", projectId: "p1", runOfShowId: "ros1", label: "x" })).ok,
    ).toBe(false);
    expect(
      (await addCue(db, { orgId: "o1", projectId: "p1", runOfShowId: "ros1", label: "x" })).ok,
    ).toBe(false);
  });

  it("edits, removes and calls cues", async () => {
    const { db, calls } = moduleClient({
      "from:cues": [
        okResponse([{ id: "c1" }]),
        okResponse([]),
        errorResponse("XX000", "b"),
        okResponse([{ id: "c1" }]),
        okResponse([]),
        errorResponse("XX000", "b"),
      ],
      "rpc:call_cue": [
        okResponse("2027-06-05T23:00:00Z"),
        errorResponse("XR001", "cue_already_called: once", "cue_already_called"),
      ],
    });
    expect(
      (await updateCue(db, "c1", { label: " Go ", plannedAt: "t", durationSeconds: 10 })).ok,
    ).toBe(true);
    expect(stepsOf(calls[0], "update")[0]?.[0]).toEqual({
      label: "Go",
      planned_at: "t",
      duration: "10 seconds",
    });
    expect(await updateCue(db, "c1", { durationSeconds: null })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await updateCue(db, "c1", {})).ok).toBe(false);
    expect((await removeCue(db, "c1")).ok).toBe(true);
    expect(await removeCue(db, "c1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await removeCue(db, "c1")).ok).toBe(false);
    expect(await callCue(db, "c1")).toEqual({
      ok: true,
      data: { calledAt: "2027-06-05T23:00:00Z" },
    });
    expect(await callCue(db, "c1")).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "cue_already_called", message: "once" },
    });
  });

  it("moves a cue one place through app.move_cue, one transaction", async () => {
    const { db, calls } = moduleClient({
      "from:cues": [
        okResponse([cueRow("c1", 1), cueRow("c2", 2)]),
        okResponse([cueRow("c1", 1), cueRow("c2", 2)]),
        okResponse([cueRow("c1", 1), cueRow("c2", 2)]),
      ],
      "rpc:move_cue": [
        okResponse(1),
        errorResponse("XR001", "cue_move_called: A called cue keeps its place."),
      ],
    });
    expect((await moveCue(db, "ros1", "c2", "up")).ok).toBe(true);
    // Up from the second place is the first 1-based place; no row is written outside the RPC.
    expect(calls.find((c) => c.target === "rpc:move_cue")?.steps[0]).toEqual([
      "args",
      [{ p_cue_id: "c2", p_to_position: 1 }],
    ]);
    expect(calls.filter((c) => stepsOf(c, "update").length > 0)).toEqual([]);
    expect(await moveCue(db, "ros1", "c1", "down")).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "cue_move_called", message: "A called cue keeps its place." },
    });
    // Down from the last place moves nothing and calls nothing.
    expect((await moveCue(db, "ros1", "c2", "down")).ok).toBe(true);
    expect(calls.filter((c) => c.target === "rpc:move_cue")).toHaveLength(2);
  });

  it("moves to a place, puts on standby and nudges through their RPCs", async () => {
    const { db, calls } = moduleClient({
      "rpc:move_cue": [okResponse(2)],
      "rpc:standby_cue": [okResponse(null), okResponse(null)],
      "rpc:shift_cue_plan": [
        okResponse(4),
        errorResponse("XR001", "cue_shift_range: Nudge by up to an hour."),
      ],
    });
    expect(await moveCueTo(db, "c5", 2)).toEqual({ ok: true, data: { position: 2 } });
    expect((await standbyCue(db, "ros1", "c3")).ok).toBe(true);
    expect((await standbyCue(db, "ros1", null)).ok).toBe(true);
    expect(await shiftCuePlan(db, "ros1", 60)).toEqual({ ok: true, data: { count: 4 } });
    expect((await shiftCuePlan(db, "ros1", 0)).ok).toBe(false);
    expect(calls.map((c) => [c.target, c.steps[0]?.[1]])).toEqual([
      ["rpc:move_cue", [{ p_cue_id: "c5", p_to_position: 2 }]],
      ["rpc:standby_cue", [{ p_run_of_show_id: "ros1", p_cue_id: "c3" }]],
      ["rpc:standby_cue", [{ p_run_of_show_id: "ros1", p_cue_id: null }]],
      ["rpc:shift_cue_plan", [{ p_run_of_show_id: "ros1", p_seconds: 60 }]],
      ["rpc:shift_cue_plan", [{ p_run_of_show_id: "ros1", p_seconds: 0 }]],
    ]);
  });

  it("lists a run's department calls in enum order and saves them in one call", async () => {
    const { db, calls } = moduleClient({
      "from:cue_calls": [
        okResponse([
          { id: "k2", cue_id: "c1", call_kind: "Stage", instruction: "Podium set" },
          { id: "k1", cue_id: "c1", call_kind: "Audio", instruction: "Host mic live" },
        ]),
      ],
      "rpc:save_cue_calls": [okResponse(null)],
    });
    const listed = await listCueCalls(db, "ros1");
    expect(listed.ok && listed.data.map((c) => c.kind)).toEqual(["Audio", "Stage"]);
    expect(stepsOf(calls[0], "eq")).toEqual([["cue.run_of_show_id", "ros1"]]);
    expect((await saveCueCalls(db, "c1", { Lighting: "LX 14 GO", Audio: null })).ok).toBe(true);
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_cue_id: "c1", p_calls: { Lighting: "LX 14 GO", Audio: null } }],
    ]);
  });

  it("derives live progression as indices into the cues in position order", () => {
    const now = new Date("2027-06-05T23:00:00Z");
    expect(cueProgress([], now)).toEqual({
      current: -1,
      next: -1,
      nextInSeconds: null,
      elapsedSeconds: null,
      complete: false,
      standby: false,
      skipped: [],
    });
    const cues = [
      cue({ id: "a", calledAt: "2027-06-05T22:59:00Z" }),
      cue({ id: "b", position: 2, plannedAt: "2027-06-05T23:02:00Z" }),
      cue({ id: "c", position: 3 }),
    ];
    expect(cueProgress(cues, now)).toEqual({
      current: 0,
      next: 1,
      nextInSeconds: 120,
      elapsedSeconds: 60,
      complete: false,
      standby: false,
      skipped: [],
    });
    const done = cues.map((c) => ({ ...c, calledAt: "2027-06-05T22:00:00Z" }));
    expect(cueProgress(done, now)).toMatchObject({ current: 2, next: -1, complete: true });
    expect(cueProgress([cue()], now)).toMatchObject({ current: -1, next: 0, nextInSeconds: null });
  });

  it("derives progression from the called and planned times alone (P1 display screens)", () => {
    const now = new Date("2027-06-05T23:00:00Z");
    const slim = [
      { position: 1, durationSeconds: null, calledAt: "2027-06-05T22:59:00Z", plannedAt: null },
      { position: 2, durationSeconds: null, calledAt: null, plannedAt: "2027-06-05T23:02:00Z" },
    ];
    expect(cueProgress(slim, now)).toMatchObject({
      current: 0,
      next: 1,
      nextInSeconds: 120,
      elapsedSeconds: 60,
      complete: false,
    });
  });
});

describe("sheets", () => {
  it("lists day sheets and saves by day", async () => {
    const { db, calls } = moduleClient({
      "from:day_sheets": [
        okResponse([
          {
            id: "d1",
            project_id: "p1",
            day: "2027-06-05",
            body: "Doors 7 pm.",
            published_at: null,
            updated_at: "t",
            project: { project_key: "NWL" },
          },
          {
            id: "d2",
            project_id: "p1",
            day: "2027-06-06",
            published_at: null,
            updated_at: "t",
            project: null,
          },
        ]),
        errorResponse("XX000", "b"),
        okResponse({ id: "d1" }),
        okResponse(null),
        okResponse(null),
        okResponse({ id: "d3" }),
        errorResponse("XX000", "b"),
        okResponse({ id: "d1" }),
        errorResponse("XX000", "b"),
        okResponse(null),
        errorResponse("XX000", "b"),
      ],
    });
    const list = await listDaySheets(db, {
      orgId: "o1",
      projectId: "p1",
      from: "2027-06-01",
      to: "2027-06-30",
    });
    expect(list.ok && list.data.map((d) => [d.projectKey, d.body])).toEqual([
      ["NWL", "Doors 7 pm."],
      ["", ""],
    ]);
    expect(stepsOf(calls[0], "lte")).toEqual([["day", "2027-06-30"]]);
    expect((await listDaySheets(db, { orgId: "o1" })).ok).toBe(false);
    expect(
      await saveDaySheet(db, { orgId: "o1", projectId: "p1", day: "2027-06-05", body: "x" }),
    ).toEqual({
      ok: true,
      data: { id: "d1" },
    });
    expect(
      await saveDaySheet(db, { orgId: "o1", projectId: "p1", day: "2027-06-07", body: "x" }),
    ).toEqual({
      ok: true,
      data: { id: "d3" },
    });
    expect((await saveDaySheet(db, { orgId: "o1", projectId: "p1", day: "x", body: "x" })).ok).toBe(
      false,
    );
    expect((await saveDaySheet(db, { orgId: "o1", projectId: "p1", day: "x", body: "x" })).ok).toBe(
      false,
    );
    expect((await saveDaySheet(db, { orgId: "o1", projectId: "p1", day: "x", body: "x" })).ok).toBe(
      false,
    );
  });

  it("publishes and deletes sheets", async () => {
    const { db } = moduleClient({
      "from:call_sheets": [
        okResponse([{ id: "s1" }]),
        okResponse([]),
        errorResponse("XR001", "sheet_publish_capability: no", "sheet_publish_capability"),
        okResponse([{ id: "s1" }]),
        okResponse([]),
        errorResponse("XX000", "b"),
      ],
    });
    expect((await publishSheet(db, "call_sheets", "s1")).ok).toBe(true);
    expect(await publishSheet(db, "call_sheets", "s1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await publishSheet(db, "call_sheets", "s1")).ok).toBe(false);
    expect((await deleteSheet(db, "call_sheets", "s1")).ok).toBe(true);
    expect(await deleteSheet(db, "call_sheets", "s1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await deleteSheet(db, "call_sheets", "s1")).ok).toBe(false);
  });

  it("restores a trashed day sheet, the undo of a delete", async () => {
    const { db, calls } = moduleClient({
      "from:day_sheets": [
        okResponse([{ id: "d1" }]),
        okResponse([]),
        errorResponse("23505", "duplicate key value violates unique constraint"),
      ],
    });
    expect(await restoreSheet(db, "day_sheets", "d1")).toEqual({ ok: true, data: null });
    expect(stepsOf(calls[0], "update")).toEqual([[{ deleted_at: null }]]);
    expect(stepsOf(calls[0], "not")).toEqual([["deleted_at", "is", null]]);
    expect(await restoreSheet(db, "day_sheets", "d1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await restoreSheet(db, "day_sheets", "d1")).ok).toBe(false);
  });

  it("lists and creates call sheets", async () => {
    const { db } = moduleClient({
      "from:call_sheets": [
        okResponse([
          {
            id: "s1",
            project_id: "p1",
            day: "2027-06-05",
            published_at: "t",
            updated_at: "t",
            project: { project_key: "NWL" },
          },
        ]),
        okResponse([
          {
            id: "s2",
            project_id: "p1",
            day: "2027-06-06",
            published_at: null,
            updated_at: "t",
            project: null,
          },
        ]),
        errorResponse("XX000", "b"),
        okResponse({ id: "s3" }),
        errorResponse("23505", "dup"),
      ],
    });
    const list = await listCallSheets(db, { orgId: "o1", projectId: "p1", from: "a", to: "b" });
    expect(list.ok && list.data[0]?.projectKey).toBe("NWL");
    const other = await listCallSheets(db, { orgId: "o1" });
    expect(other.ok && other.data[0]?.projectKey).toBe("");
    expect((await listCallSheets(db, { orgId: "o1" })).ok).toBe(false);
    expect(await createCallSheet(db, { orgId: "o1", projectId: "p1", day: "2027-06-05" })).toEqual({
      ok: true,
      data: { id: "s3" },
    });
    expect(
      (await createCallSheet(db, { orgId: "o1", projectId: "p1", day: "2027-06-05" })).ok,
    ).toBe(false);
  });

  it("derives calls from the day's shifts in the project zone", async () => {
    const { db, calls } = moduleClient({
      "from:shifts": [
        okResponse([
          {
            id: "sh1",
            starts_at: "2027-06-05T12:00:00Z",
            ends_at: "2027-06-05T20:00:00Z",
            role_code: "5000.01.01",
            membership: { person: { full_name: "Lee" } },
          },
          {
            id: "sh2",
            starts_at: "2027-06-05T13:00:00Z",
            ends_at: "2027-06-05T21:00:00Z",
            role_code: null,
            membership: null,
          },
        ]),
        okResponse([]),
        okResponse([{ id: "sh3", starts_at: "x", ends_at: "y", role_code: "9", membership: null }]),
        errorResponse("XX000", "b"),
      ],
      "xpms:from:role": [
        okResponse([{ role_code: "5000.01.01", job_title: "Stagehand" }]),
        errorResponse("XX000", "b"),
      ],
    });
    const list = await listCalls(db, {
      projectId: "p1",
      day: "2027-06-05",
      timeZone: "America/New_York",
    });
    expect(list.ok && list.data.map((c) => [c.roleTitle, c.personName])).toEqual([
      ["Stagehand", "Lee"],
      [null, null],
    ]);
    expect(stepsOf(calls[0], "gte")).toEqual([["starts_at", "2027-06-05T04:00:00.000Z"]]);
    expect(stepsOf(calls[0], "lt")).toEqual([["starts_at", "2027-06-06T04:00:00.000Z"]]);
    expect(await listCalls(db, { projectId: "p1", day: "2027-06-05", timeZone: "UTC" })).toEqual({
      ok: true,
      data: [],
    });
    expect((await listCalls(db, { projectId: "p1", day: "2027-06-05", timeZone: "UTC" })).ok).toBe(
      false,
    );
    expect((await listCalls(db, { projectId: "p1", day: "2027-06-05", timeZone: "UTC" })).ok).toBe(
      false,
    );
  });

  it("finds local midnight across offsets", () => {
    expect(zonedMidnight("2027-01-15", "America/New_York")).toBe("2027-01-15T05:00:00.000Z");
    expect(zonedMidnight("2027-07-15", "Asia/Tokyo")).toBe("2027-07-14T15:00:00.000Z");
    expect(zonedMidnight("2027-03-14", "UTC")).toBe("2027-03-14T00:00:00.000Z");
  });
});

describe("set times", () => {
  it("lists the set times of a running order with the artist's name", async () => {
    const { db, calls } = moduleClient({
      "from:engagement_cues": [
        okResponse([
          {
            id: "ec1",
            cue_id: "c1",
            engagement_id: "e1",
            engagement: { person: { full_name: "Arturo Bell" } },
          },
          { id: "ec2", cue_id: "c2", engagement_id: "e2", engagement: null },
        ]),
        errorResponse("XX000", "b"),
      ],
    });
    expect(await listCueEngagements(db, "ros1")).toEqual({
      ok: true,
      data: [
        { id: "ec1", cueId: "c1", engagementId: "e1", personName: "Arturo Bell" },
        { id: "ec2", cueId: "c2", engagementId: "e2", personName: null },
      ],
    });
    expect(stepsOf(calls[0], "eq")).toEqual([["cue.run_of_show_id", "ros1"]]);
    expect((await listCueEngagements(db, "ros1")).ok).toBe(false);
  });

  it("links a cue to an artist engagement and unlinks it", async () => {
    const { db, calls } = moduleClient({
      "from:engagement_cues": [
        okResponse({ id: "ec9" }),
        errorResponse(
          "XR001",
          "engagement_cue_artist_only: Set times belong to artist engagements.",
          "engagement_cue_artist_only",
        ),
        errorResponse("23505", "duplicate key value"),
        okResponse([{ id: "ec9" }]),
        okResponse([]),
      ],
    });
    expect(await linkCueToEngagement(db, { cueId: "c1", engagementId: "e1" })).toEqual({
      ok: true,
      data: { id: "ec9" },
    });
    expect(stepsOf(calls[0], "insert")).toEqual([[{ engagement_id: "e1", cue_id: "c1" }]]);
    const refused = await linkCueToEngagement(db, { cueId: "c1", engagementId: "e2" });
    expect(!refused.ok && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "engagement_cue_artist_only",
    );
    const duplicate = await linkCueToEngagement(db, { cueId: "c1", engagementId: "e1" });
    expect(!duplicate.ok && duplicate.error.kind).toBe("conflict");
    expect(await unlinkCueEngagement(db, "ec9")).toEqual({ ok: true, data: null });
    expect(stepsOf(calls[3], "update")[0]?.[0]).toHaveProperty("deleted_at");
    expect(await unlinkCueEngagement(db, "ec9")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});
