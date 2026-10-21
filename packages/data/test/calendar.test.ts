import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  dateIn,
  isTimeZone,
  startOfDayIn,
  todayIn,
  zoneOrUtc,
} from "../src/calendar.ts";

// 23:30 on the last evening of October 2026 in New York: already 1 November in UTC.
const LATE_EVENING = new Date("2026-11-01T03:30:00Z");

describe("calendar dates in a place's time zone (A71)", () => {
  it("knows IANA zones and falls back to UTC for anything else", () => {
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("Nowhere/Zone")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(null)).toBe(false);
    expect(zoneOrUtc("Europe/London")).toBe("Europe/London");
    expect(zoneOrUtc("Mars/Base")).toBe("UTC");
    expect(zoneOrUtc(undefined)).toBe("UTC");
  });

  it("dates the evening in New York on New York's calendar, not UTC's", () => {
    expect(LATE_EVENING.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(todayIn("America/New_York", LATE_EVENING)).toBe("2026-10-31");
    expect(todayIn("UTC", LATE_EVENING)).toBe("2026-11-01");
    expect(todayIn("Pacific/Kiritimati", LATE_EVENING)).toBe("2026-11-01");
    expect(todayIn(null, LATE_EVENING)).toBe("2026-11-01");
    expect(dateIn(new Date("2027-01-01T04:30:00Z"), "America/New_York")).toBe("2026-12-31");
  });

  it("starts a day at local midnight, across daylight saving changes", () => {
    expect(startOfDayIn("2026-10-19", "America/New_York")).toBe("2026-10-19T04:00:00.000Z");
    expect(startOfDayIn("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00.000Z");
    expect(startOfDayIn("2026-11-02", "America/New_York")).toBe("2026-11-02T05:00:00.000Z");
    expect(startOfDayIn("2027-03-14", "America/New_York")).toBe("2027-03-14T05:00:00.000Z");
    expect(startOfDayIn("2027-03-15", "America/New_York")).toBe("2027-03-15T04:00:00.000Z");
    expect(startOfDayIn("2026-10-19", "Asia/Tokyo")).toBe("2026-10-18T15:00:00.000Z");
    expect(startOfDayIn("2026-10-19", "Nowhere/Zone")).toBe("2026-10-19T00:00:00.000Z");
  });

  it("adds calendar days", () => {
    expect(addCalendarDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2026-10-19", -7)).toBe("2026-10-12");
  });
});
