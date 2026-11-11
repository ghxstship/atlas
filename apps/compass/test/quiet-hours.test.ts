import { describe, expect, it } from "vitest";
import { checkQuietHours, isDigest, normalizeTime } from "../src/settings/notifications";
import { COMMON_ZONES, knownZones, matchZones, zoneLabel } from "../src/settings/zones";

/**
 * Quiet hours and the digest are checked on the phone before they queue (A111), with the rules Atlas and Gateway
 * apply and the database repeats: both times or neither, each a time of day, the end not the start, a known zone.
 */

describe("a typed time", () => {
  it.each([
    ["22:00", "22:00"],
    ["9:30", "09:30"],
    [" 07:05 ", "07:05"],
    ["0:00", "00:00"],
    ["23:59", "23:59"],
  ])("%s reads as %s", (typed, time) => {
    expect(normalizeTime(typed)).toBe(time);
  });

  it.each(["24:00", "12:60", "7", "7:5", "noon", "", "12:00:00", "-1:00"])(
    "%s is not a time of day",
    (typed) => {
      expect(normalizeTime(typed)).toBeNull();
    },
  );
});

describe("quiet hours", () => {
  const zone = "America/New_York";

  it("pass with both times and a zone, normalized", () => {
    expect(checkQuietHours({ start: "22:00", end: "7:00", timeZone: zone })).toEqual({
      ok: true,
      value: { start: "22:00", end: "07:00", timeZone: zone },
    });
  });

  it("may span midnight or sit inside one day", () => {
    expect(checkQuietHours({ start: "23:00", end: "06:00", timeZone: zone }).ok).toBe(true);
    expect(checkQuietHours({ start: "12:00", end: "13:30", timeZone: zone }).ok).toBe(true);
  });

  it("turn off with both times blank", () => {
    expect(checkQuietHours({ start: " ", end: "", timeZone: zone })).toEqual({
      ok: true,
      value: { start: null, end: null, timeZone: zone },
    });
  });

  it("need both times or neither", () => {
    expect(checkQuietHours({ start: "22:00", end: "", timeZone: zone })).toEqual({
      ok: false,
      errors: { end: "pair" },
    });
    expect(checkQuietHours({ start: "", end: "07:00", timeZone: zone })).toEqual({
      ok: false,
      errors: { start: "pair" },
    });
  });

  it("refuse an end equal to the start, however it was typed", () => {
    expect(checkQuietHours({ start: "7:00", end: "07:00", timeZone: zone })).toEqual({
      ok: false,
      errors: { end: "same" },
    });
  });

  it("name each field that is not a time", () => {
    expect(checkQuietHours({ start: "25:00", end: "late", timeZone: zone })).toEqual({
      ok: false,
      errors: { start: "time", end: "time" },
    });
    // A field that is not a time is reported as such, never as half of a missing pair.
    expect(checkQuietHours({ start: "9pm", end: "", timeZone: zone })).toEqual({
      ok: false,
      errors: { start: "time" },
    });
  });

  it("need a zone the phone knows, never assuming UTC", () => {
    expect(checkQuietHours({ start: "22:00", end: "07:00", timeZone: "" })).toEqual({
      ok: false,
      errors: { timeZone: "zone" },
    });
    expect(checkQuietHours({ start: "", end: "", timeZone: "Mars/Olympus" })).toEqual({
      ok: false,
      errors: { timeZone: "zone" },
    });
    expect(checkQuietHours({ start: "", end: "", timeZone: " UTC " }).ok).toBe(true);
  });

  it("report every problem at once", () => {
    expect(checkQuietHours({ start: "22:00", end: "22:00", timeZone: "nowhere" })).toEqual({
      ok: false,
      errors: { timeZone: "zone", end: "same" },
    });
  });
});

describe("the digest", () => {
  it("is one of Atlas's frequencies at an hour of the day", () => {
    expect(isDigest("Off", 8)).toBe(true);
    expect(isDigest("Daily", 0)).toBe(true);
    expect(isDigest("Weekly", 23)).toBe(true);
    expect(isDigest("Hourly", 8)).toBe(false);
    expect(isDigest("Daily", 24)).toBe(false);
    expect(isDigest("Daily", 7.5)).toBe(false);
    expect(isDigest("Daily", -1)).toBe(false);
  });
});

describe("the time zone picker", () => {
  const zones = knownZones(() => ["America/New_York", "UTC", "America/Los_Angeles", "Europe/Rome"]);

  it("lists the runtime's zones with UTC first", () => {
    expect(zones).toEqual(["UTC", "America/New_York", "America/Los_Angeles", "Europe/Rome"]);
  });

  it("falls back to common zones when the runtime cannot list its own", () => {
    const fallback = knownZones(null);
    expect(fallback[0]).toBe("UTC");
    expect(fallback).toEqual(["UTC", ...COMMON_ZONES]);
    expect(fallback.slice(1, 6)).toContain("America/Chicago");
  });

  it("finds a zone by city, with spaces or underscores, in any case", () => {
    expect(matchZones("los angeles", zones)).toEqual(["America/Los_Angeles"]);
    expect(matchZones("NEW_YORK", zones)).toEqual(["America/New_York"]);
    expect(matchZones("america", zones)).toEqual(["America/New_York", "America/Los_Angeles"]);
  });

  it("puts the phone's zone first when it matches", () => {
    expect(matchZones("", zones, "Europe/Rome").slice(0, 2)).toEqual(["Europe/Rome", "UTC"]);
    expect(matchZones("america", zones, "Europe/Rome")).toEqual([
      "America/New_York",
      "America/Los_Angeles",
    ]);
  });

  it("offers a zone typed in full even when the list lacks it", () => {
    expect(matchZones("Asia/Tokyo", zones)).toEqual(["Asia/Tokyo"]);
    expect(matchZones("Asia/Nowhere", zones)).toEqual([]);
  });

  it("caps the list", () => {
    expect(matchZones("", knownZones(null), null, 5)).toHaveLength(5);
  });

  it("reads underscores as spaces", () => {
    expect(zoneLabel("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos Aires");
  });
});
