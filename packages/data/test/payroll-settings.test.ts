import { describe, expect, it } from "vitest";
import {
  addHoliday,
  assignHolidayCalendarVenue,
  createEarningCode,
  createHolidayCalendar,
  createTimeOffPolicy,
  daysBetween,
  listHolidayCalendars,
  listTimeOffRequests,
  normalizeEarningCode,
  normalizeSubdivisionCode,
  removeHoliday,
  retireEarningCode,
  retireHolidayCalendar,
  retireTimeOffPolicy,
  unassignHolidayCalendarVenue,
  updateEarningCode,
  updateHolidayCalendar,
  updateTimeOffPolicy,
} from "../src/crew.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/**
 * The writes behind Settings, Payroll and Time Off (A134, migrations 0341 and 2270): earning codes by kind, time off
 * policies, holiday calendars with their holidays and venues, and a time off request's day count.
 */

const AT = new Date("2027-07-01T12:00:00Z");

describe("earning codes", () => {
  it("normalizes codes to the stored format", () => {
    expect(normalizeEarningCode(" hol ")).toBe("HOL");
    expect(normalizeEarningCode("dt_2")).toBe("DT_2");
    expect(normalizeEarningCode("x")).toBeNull();
    expect(normalizeEarningCode("REG-1")).toBeNull();
  });

  it("writes a code's kind as its two flags and soft deletes on retire", async () => {
    const { db, calls } = fakeClient({
      "from:earning_codes": [
        okResponse({ id: "e1" }),
        errorResponse("23505", "duplicate key value"),
        okResponse([{ id: "e1" }]),
        okResponse([]),
        okResponse([{ id: "e1" }]),
      ],
    });
    expect(
      await createEarningCode(db, "o1", { code: "HOL", name: " Holiday ", kind: "holiday" }),
    ).toEqual({
      ok: true,
      data: { id: "e1" },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ org_id: "o1", code: "HOL", name: "Holiday", is_overtime: false, is_holiday: true }],
    ]);
    const taken = await createEarningCode(db, "o1", {
      code: "HOL",
      name: "Again",
      kind: "regular",
    });
    expect(!taken.ok && taken.error.kind).toBe("conflict");
    expect(
      (await updateEarningCode(db, "e1", { code: "OT", name: "Overtime", kind: "overtime" })).ok,
    ).toBe(true);
    expect(calls[2]?.steps[0]).toEqual([
      "update",
      [{ code: "OT", name: "Overtime", is_overtime: true, is_holiday: false }],
    ]);
    const unseen = await updateEarningCode(db, "e9", {
      code: "OT",
      name: "Overtime",
      kind: "overtime",
    });
    expect(!unseen.ok && unseen.error.kind).toBe("not-found");
    expect((await retireEarningCode(db, "e1", AT)).ok).toBe(true);
    expect(calls[4]?.steps[0]).toEqual(["update", [{ deleted_at: AT.toISOString() }]]);
  });
});

describe("time off policies", () => {
  it("creates, edits and retires a policy", async () => {
    const { db, calls } = fakeClient({
      "from:time_off_policies": [
        okResponse({ id: "p1" }),
        okResponse([{ id: "p1" }]),
        okResponse([{ id: "p1" }]),
        errorResponse("42501", "permission denied"),
      ],
    });
    expect(
      await createTimeOffPolicy(db, "o1", { name: "Paid Time Off", accrualHoursPerPeriod: 4 }),
    ).toEqual({
      ok: true,
      data: { id: "p1" },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ org_id: "o1", name: "Paid Time Off", accrual_hours_per_period: 4 }],
    ]);
    expect(
      (await updateTimeOffPolicy(db, "p1", { name: "Vacation ", accrualHoursPerPeriod: null })).ok,
    ).toBe(true);
    expect(calls[1]?.steps[0]).toEqual([
      "update",
      [{ name: "Vacation", accrual_hours_per_period: null }],
    ]);
    expect((await retireTimeOffPolicy(db, "p1", AT)).ok).toBe(true);
    const denied = await retireTimeOffPolicy(db, "p1", AT);
    expect(!denied.ok && denied.error.kind).toBe("not-found");
  });
});

describe("holiday calendars", () => {
  it("normalizes subdivision codes: blank is none, a bad code is undefined", () => {
    expect(normalizeSubdivisionCode(" us-ca ")).toBe("US-CA");
    expect(normalizeSubdivisionCode("")).toBeNull();
    expect(normalizeSubdivisionCode("California")).toBeUndefined();
  });

  it("lists live calendars with live holidays in date order and their venues", async () => {
    const { db, calls } = fakeClient({
      "from:holiday_calendars": [
        okResponse([
          {
            id: "c1",
            name: "United States",
            subdivision_code: null,
            applies_to_org: true,
            holidays: [
              {
                id: "h2",
                observed_on: "2027-12-24",
                name: "Christmas Eve",
                paid_hours: "4",
                deleted_at: null,
              },
              {
                id: "h1",
                observed_on: "2027-07-05",
                name: "Independence Day",
                paid_hours: 8,
                deleted_at: null,
              },
              {
                id: "h0",
                observed_on: "2027-01-01",
                name: "Gone",
                paid_hours: 8,
                deleted_at: "2027-01-02",
              },
            ],
            venues: [
              { id: "a2", venue_id: "v2", deleted_at: null, venue: { name: "Pier" } },
              { id: "a1", venue_id: "v1", deleted_at: null, venue: { name: "Arena" } },
              { id: "a0", venue_id: "v0", deleted_at: "2027-01-02", venue: { name: "Old" } },
            ],
          },
          {
            id: "c2",
            name: "Empty",
            subdivision_code: "US-CA",
            applies_to_org: false,
            holidays: null,
            venues: null,
          },
        ]),
        errorResponse("PGRST301", "boom"),
      ],
    });
    const calendars = await listHolidayCalendars(db, "o1");
    expect(calendars.ok && calendars.data).toEqual([
      {
        id: "c1",
        name: "United States",
        subdivisionCode: null,
        appliesToOrg: true,
        venues: [
          { assignmentId: "a1", venueId: "v1", name: "Arena" },
          { assignmentId: "a2", venueId: "v2", name: "Pier" },
        ],
        holidays: [
          { id: "h1", observedOn: "2027-07-05", name: "Independence Day", paidHours: 8 },
          { id: "h2", observedOn: "2027-12-24", name: "Christmas Eve", paidHours: 4 },
        ],
      },
      {
        id: "c2",
        name: "Empty",
        subdivisionCode: "US-CA",
        appliesToOrg: false,
        venues: [],
        holidays: [],
      },
    ]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "o1"]]);
    expect((await listHolidayCalendars(db, "o1")).ok).toBe(false);
  });

  it("writes calendars, holidays and venue assignments", async () => {
    const { db, calls } = fakeClient({
      "from:holiday_calendars": [
        okResponse({ id: "c1" }),
        okResponse([{ id: "c1" }]),
        okResponse([{ id: "c1" }]),
      ],
      "from:holidays": [
        okResponse({ id: "h1" }),
        errorResponse("23505", "duplicate"),
        okResponse([{ id: "h1" }]),
      ],
      "from:holiday_calendar_venues": [okResponse({ id: "a1" }), okResponse([{ id: "a1" }])],
    });
    const input = { name: " California ", subdivisionCode: "US-CA", appliesToOrg: true };
    expect(await createHolidayCalendar(db, "o1", input)).toEqual({ ok: true, data: { id: "c1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ org_id: "o1", name: "California", subdivision_code: "US-CA", applies_to_org: true }],
    ]);
    expect((await updateHolidayCalendar(db, "c1", { ...input, appliesToOrg: false })).ok).toBe(
      true,
    );
    const holiday = {
      orgId: "o1",
      calendarId: "c1",
      observedOn: "2027-07-05",
      name: "Independence Day",
      paidHours: 8,
    };
    expect(await addHoliday(db, holiday)).toEqual({ ok: true, data: { id: "h1" } });
    const twice = await addHoliday(db, holiday);
    expect(!twice.ok && twice.error.kind).toBe("conflict");
    expect((await removeHoliday(db, "h1", AT)).ok).toBe(true);
    expect(
      await assignHolidayCalendarVenue(db, { orgId: "o1", calendarId: "c1", venueId: "v1" }),
    ).toEqual({
      ok: true,
      data: { id: "a1" },
    });
    expect((await unassignHolidayCalendarVenue(db, "a1", AT)).ok).toBe(true);
    expect((await retireHolidayCalendar(db, "c1", AT)).ok).toBe(true);
  });
});

describe("time off day counts", () => {
  it("counts both ends", () => {
    expect(daysBetween("2027-07-02", "2027-07-06")).toBe(5);
    expect(daysBetween("2027-07-02", "2027-07-02")).toBe(1);
    expect(daysBetween("2027-03-13", "2027-03-15")).toBe(3);
  });

  it("reads the computed day count, falling back to the span", async () => {
    const row = {
      id: "t1",
      time_off_policy_id: "p1",
      membership_id: "m1",
      starts_on: "2027-07-02",
      ends_on: "2027-07-06",
      hours: 32,
      time_off_state: "Proposed",
      created_by: "x",
      created_at: "2027-06-01T00:00:00Z",
      policy: { name: "Vacation" },
      membership: { id: "m1", person_id: "pp1", person: { full_name: "Frank Adeyemi" } },
    };
    const { db, calls } = fakeClient({
      "from:time_off_requests": [
        okResponse([
          { ...row, time_off_day_count: 4 },
          { ...row, id: "t2", time_off_day_count: null },
        ]),
      ],
    });
    const requests = await listTimeOffRequests(db, { orgId: "o1" });
    expect(requests.ok && requests.data.map((r) => r.dayCount)).toEqual([4, 5]);
    expect(String(calls[0]?.steps[0]?.[1]?.[0])).toContain("time_off_day_count");
  });
});
