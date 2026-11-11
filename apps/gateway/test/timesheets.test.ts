import { describe, expect, it } from "vitest";
import { timesheetWarnings } from "../lib/timesheets";

/** 4.9 surface crawl: an empty or unfinished period is named before the person certifies it. */
describe("timesheetWarnings", () => {
  const today = "2026-11-10";

  it("names a timesheet with no hours", () => {
    expect(timesheetWarnings({ workedMinutes: 0, periodEnd: "2026-11-01" }, today)).toEqual([
      "empty",
    ]);
    expect(timesheetWarnings({ workedMinutes: null, periodEnd: "2026-11-01" }, today)).toEqual([
      "empty",
    ]);
  });

  it("names a period that has not ended yet, today included", () => {
    expect(timesheetWarnings({ workedMinutes: 480, periodEnd: "2026-11-10" }, today)).toEqual([
      "future",
    ]);
    expect(timesheetWarnings({ workedMinutes: 0, periodEnd: "2027-06-06" }, today)).toEqual([
      "empty",
      "future",
    ]);
  });

  it("says nothing about a finished period with hours", () => {
    expect(timesheetWarnings({ workedMinutes: 480, periodEnd: "2026-11-09" }, today)).toEqual([]);
  });
});
