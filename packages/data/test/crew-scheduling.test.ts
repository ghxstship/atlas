import { describe, expect, it } from "vitest";
import {
  addAvailabilityPeriod,
  assignOpenShift,
  createShiftsFromTemplate,
  createShiftTemplate,
  daysBetween,
  fillRate,
  getMyAvailabilityStatus,
  listShiftTemplates,
  rankShiftCandidates,
  templateMinutes,
} from "../src/crew.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/**
 * Crew scheduling (A132, migrations 2250 and 2251): shift templates and planning from one, the fill rate, the
 * member's availability window and the candidates ranked for a shift.
 */

const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: no`, hint: rule },
});

describe("shift templates", () => {
  it("lists templates with times as HH:MM", async () => {
    const { db, calls } = fakeClient({
      "from:shift_templates": [
        okResponse([
          {
            id: "t1",
            name: "Stagehand day",
            role_code: "0000.50.01",
            call_time: "08:00:00",
            wrap_time: "16:30:00",
            headcount: 2,
            break_minutes: 30,
          },
        ]),
      ],
    });
    const listed = await listShiftTemplates(db, "o1");
    expect(listed.ok && listed.data[0]).toEqual({
      id: "t1",
      name: "Stagehand day",
      roleCode: "0000.50.01",
      callTime: "08:00",
      wrapTime: "16:30",
      headcount: 2,
      breakMinutes: 30,
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "o1"]]);
    expect(calls[0]?.steps).toContainEqual(["is", ["deleted_at", null]]);
  });

  it("adds a template with a trimmed name and reports a duplicate as a conflict", async () => {
    const { db, calls } = fakeClient({
      "from:shift_templates": [
        okResponse({ id: "t2" }),
        { data: null, error: { code: "23505", message: "duplicate key" } },
      ],
    });
    const input = {
      orgId: "o1",
      name: "  Load-out night ",
      roleCode: null,
      callTime: "22:00",
      wrapTime: "06:00",
      headcount: 4,
      breakMinutes: 30,
    };
    expect(await createShiftTemplate(db, input)).toEqual({ ok: true, data: { id: "t2" } });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [
        {
          org_id: "o1",
          name: "Load-out night",
          role_code: null,
          call_time: "22:00",
          wrap_time: "06:00",
          headcount: 4,
          break_minutes: 30,
        },
      ],
    ]);
    const duplicate = await createShiftTemplate(db, input);
    expect(duplicate.ok === false && duplicate.error.kind).toBe("conflict");
  });

  it("measures overnight templates past midnight", () => {
    expect(templateMinutes({ callTime: "08:00", wrapTime: "16:30" })).toBe(510);
    expect(templateMinutes({ callTime: "22:00", wrapTime: "06:00" })).toBe(480);
  });

  it("lists the days of a range, both ends included", () => {
    expect(daysBetween("2027-02-27", "2027-03-02")).toEqual([
      "2027-02-27",
      "2027-02-28",
      "2027-03-01",
      "2027-03-02",
    ]);
    expect(daysBetween("2027-03-02", "2027-03-01")).toEqual([]);
  });

  it("plans shifts through the RPC and passes its refusal on", async () => {
    const { db, calls } = fakeClient({
      "rpc:create_shifts_from_template": [okResponse(["s1", "s2"]), refused("shift_template_days")],
    });
    const input = { templateId: "t1", projectId: "p1", days: ["2027-08-02"] };
    expect(await createShiftsFromTemplate(db, input)).toEqual({
      ok: true,
      data: { ids: ["s1", "s2"] },
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { p_template_id: "t1", p_project_id: "p1", p_days: ["2027-08-02"] },
    ]);
    const days = await createShiftsFromTemplate(db, input);
    expect(days.ok === false && days.error).toMatchObject({
      kind: "refusal",
      rule: "shift_template_days",
    });
  });
});

describe("fill rate", () => {
  it("counts the live shifts with someone on them", () => {
    expect(
      fillRate([
        { state: "Published", assigned: true },
        { state: "Draft", assigned: false },
        { state: "Accepted", assigned: true },
        { state: "Canceled", assigned: false },
      ]),
    ).toEqual({ filled: 2, total: 3, percent: 67 });
    expect(fillRate([])).toEqual({ filled: 0, total: 0, percent: 0 });
  });
});

describe("availability", () => {
  it("reads the member's window", async () => {
    const { db } = fakeClient({
      "rpc:my_availability_status": [
        okResponse([
          {
            availability_calendar_id: "c1",
            time_zone: "America/New_York",
            required: true,
            notice_days: 7,
            horizon_days: 28,
            locked_until: "2027-08-09",
            unstated_days: ["2027-08-09", "2027-08-10"],
          },
        ]),
        okResponse([]),
      ],
    });
    expect(await getMyAvailabilityStatus(db, "o1")).toEqual({
      ok: true,
      data: {
        calendarId: "c1",
        timeZone: "America/New_York",
        required: true,
        noticeDays: 7,
        horizonDays: 28,
        lockedUntil: "2027-08-09",
        unstatedDays: ["2027-08-09", "2027-08-10"],
      },
    });
    expect((await getMyAvailabilityStatus(db, "o1")).ok).toBe(false);
  });

  it("passes the notice lock on as a refusal", async () => {
    const { db } = fakeClient({
      "from:availability_blocks": [refused("availability_inside_notice")],
    });
    const added = await addAvailabilityPeriod(db, {
      calendarId: "c1",
      startsAt: "2027-08-03T12:00:00Z",
      endsAt: "2027-08-03T20:00:00Z",
      kind: "Unavailable",
    });
    expect(added.ok === false && added.error).toMatchObject({
      kind: "refusal",
      rule: "availability_inside_notice",
    });
  });

  it("ranks candidates for a shift", async () => {
    const { db, calls } = fakeClient({
      "rpc:rank_shift_candidates": [
        okResponse([
          {
            membership_id: "m1",
            person_id: "p1",
            full_name: "Fern Field",
            availability: "Available",
            overdue: false,
            conflict: false,
            worked_role: true,
            week_minutes: 480,
            candidate_rank: 1,
          },
          {
            membership_id: "m2",
            person_id: "p2",
            full_name: null,
            availability: "Unstated",
            overdue: true,
            conflict: false,
            worked_role: false,
            week_minutes: 0,
            candidate_rank: 2,
          },
        ]),
      ],
    });
    const ranked = await rankShiftCandidates(db, "s1", "2027-08-01");
    expect(
      ranked.ok && ranked.data.map((c) => [c.name, c.availability, c.overdue, c.rank]),
    ).toEqual([
      ["Fern Field", "Available", false, 1],
      [null, "Unstated", true, 2],
    ]);
    expect(calls[0]?.steps[0]?.[1]).toEqual([{ p_shift_id: "s1", p_week_start: "2027-08-01" }]);
  });
});

describe("assigning an open shift", () => {
  it("lands only while nobody holds the shift", async () => {
    const { db, calls } = fakeClient({ "from:shifts": [okResponse([{ id: "s1" }])] });
    expect(await assignOpenShift(db, "s1", "m1")).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps).toContainEqual(["update", [{ membership_id: "m1" }]]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["id", "s1"]]);
    expect(calls[0]?.steps).toContainEqual(["is", ["membership_id", null]]);
    expect(calls[0]?.steps).toContainEqual(["is", ["deleted_at", null]]);
  });

  it("refuses a shift someone claimed or was put on since the board was read", async () => {
    const { db, calls } = fakeClient({
      "from:shifts": [okResponse([]), okResponse({ id: "s1", membership_id: "m2" })],
    });
    const result = await assignOpenShift(db, "s1", "m1");
    expect(result.ok === false && result.error).toMatchObject({
      kind: "refusal",
      rule: "shift_already_filled",
    });
    expect(calls).toHaveLength(2);
  });

  it("reports a shift that is gone as not found", async () => {
    const { db } = fakeClient({ "from:shifts": [okResponse([]), okResponse(null)] });
    const result = await assignOpenShift(db, "s1", "m1");
    expect(result.ok === false && result.error.kind).toBe("not-found");
  });
});
