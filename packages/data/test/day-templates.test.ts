import { describe, expect, it } from "vitest";
import {
  applyDayTemplate,
  applyItemAt,
  createDayTemplateFromDay,
  listDayTemplates,
  minuteClock,
  saveDayTemplateItem,
  undoDayTemplateApplication,
} from "../src/day-templates.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** Day templates (B4, G-42, migrations 2932 and 2933): reads, item writes, the dry run, saving a day and undo. */

describe("day templates", () => {
  it("lists templates with their live item count", async () => {
    const { db } = fakeClient({
      "from:day_templates": [
        okResponse([
          {
            id: "t1",
            name: "Show Day",
            description: null,
            day_type: "Show",
            updated_at: "x",
            items: [{ count: 12 }],
          },
        ]),
      ],
    });
    const listed = await listDayTemplates(db, "o1");
    expect(listed.ok && listed.data[0]).toMatchObject({ id: "t1", dayType: "Show", itemCount: 12 });
  });

  it("keeps a Cue item free of record fields and a Record item free of a segment", async () => {
    const { db, calls } = fakeClient({ "from:day_template_items": [okResponse({ id: "i1" })] });
    await saveDayTemplateItem(db, {
      templateId: "t1",
      kind: "Cue",
      sortOrder: 1,
      name: " Headliner On ",
      recordKind: "Task",
      xyz: "Y",
      phaseCode: "SCP",
      startMinute: 1290,
      durationMinutes: 75,
      segment: "Act II",
      startTbc: false,
    });
    const insert = calls[0]?.steps.find((s) => s[0] === "insert")?.[1][0] as Record<
      string,
      unknown
    >;
    expect(insert).toMatchObject({
      name: "Headliner On",
      record_kind: null,
      xyz: null,
      phase_code: null,
      segment: "Act II",
    });
  });

  it("returns the item grammar refusal with its correction", async () => {
    const { db } = fakeClient({
      "from:day_template_items": [
        errorResponse(
          "XR001",
          "day_template_title: A Task title starts with a verb.",
          "day_template_title",
        ),
      ],
    });
    const saved = await saveDayTemplateItem(db, {
      templateId: "t1",
      kind: "Record",
      sortOrder: 1,
      name: "Installing the truss",
      recordKind: "Task",
      xyz: "Y",
      phaseCode: null,
      startMinute: 480,
      durationMinutes: 60,
      segment: null,
      startTbc: false,
    });
    expect(!saved.ok && saved.error).toEqual({
      kind: "refusal",
      rule: "day_template_title",
      message: "A Task title starts with a verb.",
    });
  });
});

describe("applying a template", () => {
  const rows = [
    {
      item_id: "i1",
      item_kind: "Record",
      name: "Doors Open",
      action: "create",
      refusal_code: null,
      starts_at: null,
      ends_at: null,
      due_at: "2027-06-12T23:00:00Z",
      overlaps: 0,
      duplicate_of: null,
      created_id: null,
    },
    {
      item_id: "i2",
      item_kind: "Record",
      name: "Rig the follow spots",
      action: "skip_duplicate",
      refusal_code: null,
      starts_at: "2027-06-12T12:00:00Z",
      ends_at: "2027-06-12T14:30:00Z",
      due_at: null,
      overlaps: 1,
      duplicate_of: "r9",
      created_id: null,
    },
  ];

  it("previews with the chosen skips and maps each item", async () => {
    const { db, calls } = fakeClient({ "rpc:apply_day_template": [okResponse(rows)] });
    const applied = await applyDayTemplate(db, {
      templateId: "t1",
      projectId: "p1",
      day: "2027-06-12",
      skipItemIds: ["i3"],
      commit: false,
    });
    expect(applied.ok && applied.data.map((i) => [i.name, i.action, i.overlaps])).toEqual([
      ["Doors Open", "create", 0],
      ["Rig the follow spots", "skip_duplicate", 1],
    ]);
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({
      p_skip_item_ids: ["i3"],
      p_commit: false,
      p_include_duplicates: false,
    });
    const first = applied.ok ? applied.data[0] : undefined;
    expect(first && applyItemAt(first)).toBe("2027-06-12T23:00:00Z");
  });

  it("refuses an ambiguous running order", async () => {
    const { db } = fakeClient({
      "rpc:apply_day_template": [
        errorResponse(
          "XR001",
          "day_template_run_ambiguous: Choose one.",
          "day_template_run_ambiguous",
        ),
      ],
    });
    const applied = await applyDayTemplate(db, {
      templateId: "t1",
      projectId: "p1",
      day: "2027-06-12",
      commit: true,
    });
    expect(!applied.ok && applied.error).toMatchObject({ rule: "day_template_run_ambiguous" });
  });

  it("saves a day as a template", async () => {
    const { db, calls } = fakeClient({ "rpc:create_day_template_from_day": [okResponse("t9")] });
    const created = await createDayTemplateFromDay(db, {
      projectId: "p1",
      day: "2027-06-05",
      name: " Show Day ",
    });
    expect(created.ok && created.data.id).toBe("t9");
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({ p_name: "Show Day", p_description: null });
  });

  it("undoes an application by trashing what it created", async () => {
    const { db, calls } = fakeClient({
      "from:records": [okResponse(null)],
      "from:cues": [okResponse(null)],
    });
    const undone = await undoDayTemplateApplication(db, [
      { kind: "Record", createdId: "r1" },
      { kind: "Cue", createdId: "c1" },
      { kind: "Cue", createdId: null },
    ]);
    expect(undone.ok).toBe(true);
    expect(calls.map((c) => c.target)).toEqual(["from:records", "from:cues"]);
    expect(calls[1]?.steps).toContainEqual(["in", ["id", ["c1"]]]);
  });

  it("reads minutes as wall-clock times around midnight", () => {
    expect(minuteClock(1455)).toEqual({ time: "00:15", dayOffset: 1 });
    expect(minuteClock(-30)).toEqual({ time: "23:30", dayOffset: -1 });
    expect(minuteClock(480)).toEqual({ time: "08:00", dayOffset: 0 });
  });
});
