import { isTimeZone } from "@xos/data/calendar";
import { describe, expect, it } from "vitest";
import { EVENT_ZONE_VIEW, formatScheduleTime, scheduleViewFrom } from "../lib/format";

/**
 * Section 15 in Gateway: a shift, cue or record time shows in the event's zone (the shift's, the record's or
 * the engagement's project zone), labeled with its abbreviation; me.time_zone_display switches it to the
 * person's own locale.time_zone.
 */

const SHIFT = "2027-03-08T14:00:00Z";
const settings = (values: Record<string, unknown>) => (key: string) => values[key];

describe("Gateway schedule times under me.time_zone_display", () => {
  it("labels the event's zone by default", () => {
    expect(formatScheduleTime("en-US", SHIFT, "America/Chicago", EVENT_ZONE_VIEW)).toBe(
      "Mar 8, 2027, 8:00 AM CST",
    );
    expect(scheduleViewFrom(settings({}), isTimeZone)).toEqual(EVENT_ZONE_VIEW);
  });

  it("shows the person's own zone when they choose it", () => {
    const view = scheduleViewFrom(
      settings({ "me.time_zone_display": "viewer", "locale.time_zone": "Europe/Madrid" }),
      isTimeZone,
    );
    expect(view).toEqual({ display: "viewer", viewerZone: "Europe/Madrid" });
    expect(formatScheduleTime("es-US", SHIFT, "America/Chicago", view, "time")).toMatch(
      /^3:00\sp\.\s?m\.\sGMT\+1$/,
    );
  });

  it("stays on the event's zone when the person's zone is unknown or unset", () => {
    const view = scheduleViewFrom(
      settings({ "me.time_zone_display": "viewer", "locale.time_zone": "Nowhere/Else" }),
      isTimeZone,
    );
    expect(view.viewerZone).toBeNull();
    expect(formatScheduleTime("en-US", SHIFT, "America/Chicago", view, "time")).toBe("8:00 AM CST");
  });
});
