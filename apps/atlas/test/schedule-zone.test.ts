import type { ResolvedSetting } from "@xos/data/settings";
import { describe, expect, it } from "vitest";
import { EVENT_ZONE_VIEW, formatScheduleTime, scheduleViewOf } from "../components/work/format";
import { shellSettingsOf, viewerTimeZoneOf } from "../lib/shell/org-settings";

/**
 * Section 15: schedule times show in the event's (venue's or project's) zone by default, always labeled with
 * the zone abbreviation, and me.time_zone_display switches them to the viewer's own zone (locale.time_zone).
 */

function resolved(values: Record<string, unknown>): Map<string, ResolvedSetting> {
  return new Map(
    Object.entries(values).map(([key, value]) => [
      key,
      { key, value: value as ResolvedSetting["value"], source: "Personal", locked: false },
    ]),
  );
}

const CUE = "2027-03-08T23:30:00Z";

describe("schedule times under me.time_zone_display", () => {
  it("shows the event's zone, labeled, by default", () => {
    expect(formatScheduleTime(CUE, "en-US", "America/New_York", EVENT_ZONE_VIEW)).toBe(
      "Mar 8, 2027, 6:30 PM EST",
    );
    expect(formatScheduleTime(CUE, "en-US", "America/New_York", EVENT_ZONE_VIEW, "time")).toBe(
      "6:30 PM EST",
    );
    expect(formatScheduleTime(null, "en-US", "America/New_York", EVENT_ZONE_VIEW)).toBeNull();
  });

  it("switches to the viewer's own zone when they choose it", () => {
    const settings = shellSettingsOf(
      resolved({ "me.time_zone_display": "viewer", "locale.time_zone": "America/Los_Angeles" }),
    );
    expect(settings.preferences.timeZoneDisplay).toBe("viewer");
    expect(settings.viewerTimeZone).toBe("America/Los_Angeles");
    const view = scheduleViewOf(settings.preferences, settings.viewerTimeZone);
    expect(formatScheduleTime(CUE, "en-US", "America/New_York", view, "time")).toBe("3:30 PM PST");
    // The cookie carries the choice, so the next page renders with it.
    expect(settings.encoded).toContain("z.viewer");
  });

  it("keeps the event's zone when the viewer's own zone is unknown", () => {
    const settings = shellSettingsOf(
      resolved({ "me.time_zone_display": "viewer", "locale.time_zone": "Mars/Olympus" }),
    );
    expect(settings.viewerTimeZone).toBeNull();
    expect(viewerTimeZoneOf(resolved({}))).toBeNull();
    const view = scheduleViewOf(settings.preferences, settings.viewerTimeZone);
    expect(formatScheduleTime(CUE, "en-US", "America/New_York", view, "time")).toBe("6:30 PM EST");
  });
});
