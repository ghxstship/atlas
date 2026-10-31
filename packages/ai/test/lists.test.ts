import { describe, expect, it } from "vitest";
import {
  checkRunOfShow,
  durationSeconds,
  durationText,
  GAP_MINUTES,
  isListDraftKind,
  nextDay,
  zonedInstant,
} from "../src/lists.ts";

/**
 * The drafted-list rules (P6, parity gap G-83): the gaps and clashes check a run of show gets, on
 * the server and on every edit in the panel, and the wall-clock instants a drafted cue lands on.
 */

const cue = (position: number, plannedAt: string | null, minutes: number | null = null) => ({
  position,
  plannedAt,
  durationSeconds: minutes === null ? null : minutes * 60,
});

describe("checkRunOfShow", () => {
  it("passes a running order whose cues follow one another", () => {
    expect(
      checkRunOfShow([
        cue(1, "2027-06-05T23:00:00Z", 30),
        cue(2, "2027-06-05T23:30:00Z", 45),
        cue(3, "2027-06-06T00:30:00Z", 15),
      ]),
    ).toEqual([]);
  });

  it("flags an overlap with how far the first cue runs into the next", () => {
    expect(
      checkRunOfShow([cue(1, "2027-06-05T23:00:00Z", 45), cue(2, "2027-06-05T23:30:00Z", 10)]),
    ).toEqual([{ type: "overlap", positions: [1, 2], minutes: 15 }]);
  });

  it(`flags idle time over ${GAP_MINUTES} minutes as a gap, with its minutes`, () => {
    expect(
      checkRunOfShow([cue(1, "2027-06-05T23:00:00Z", 15), cue(2, "2027-06-05T23:45:00Z", 15)]),
    ).toEqual([]);
    expect(
      checkRunOfShow([cue(1, "2027-06-05T23:00:00Z", 15), cue(2, "2027-06-05T23:46:00Z", 15)]),
    ).toEqual([{ type: "gap", positions: [1, 2], minutes: 31 }]);
  });

  it("flags untimed cues and compares the timed cues around them", () => {
    expect(
      checkRunOfShow([
        cue(1, "2027-06-05T23:00:00Z", 30),
        cue(2, null, 10),
        cue(3, "2027-06-05T23:20:00Z", 10),
      ]),
    ).toEqual([
      { type: "untimed", positions: [2] },
      { type: "overlap", positions: [1, 3], minutes: 10 },
    ]);
  });

  it("flags times that go back as out of order, in position order", () => {
    expect(
      checkRunOfShow([cue(2, "2027-06-05T22:00:00Z", 10), cue(1, "2027-06-05T23:00:00Z", 10)]),
    ).toEqual([{ type: "out_of_order", positions: [1, 2] }]);
  });

  it("ends a cue without a duration where it starts: no overlap, gaps measured from its start", () => {
    expect(
      checkRunOfShow([cue(1, "2027-06-05T23:00:00Z"), cue(2, "2027-06-05T23:00:00Z", 10)]),
    ).toEqual([]);
    expect(
      checkRunOfShow([cue(1, "2027-06-05T23:00:00Z"), cue(2, "2027-06-05T23:40:00Z", 10)]),
    ).toEqual([{ type: "gap", positions: [1, 2], minutes: 40 }]);
  });

  it("checks a running order that crosses midnight", () => {
    const encore = zonedInstant(nextDay("2027-06-05"), "00:15", "America/New_York");
    expect(encore).toBe("2027-06-06T04:15:00.000Z");
    expect(
      checkRunOfShow([
        cue(1, zonedInstant("2027-06-05", "23:30", "America/New_York"), 45),
        cue(2, encore, 20),
      ]),
    ).toEqual([]);
  });

  it("measures real minutes on a daylight saving change day", () => {
    // 2026-11-01 in New York: 01:00 to 02:00 happens twice, so 00:30 to 03:00 is 3.5 hours.
    const first = zonedInstant("2026-11-01", "00:30", "America/New_York");
    const second = zonedInstant("2026-11-01", "03:00", "America/New_York");
    expect(checkRunOfShow([cue(1, first, 60), cue(2, second, 10)])).toEqual([
      { type: "gap", positions: [1, 2], minutes: 150 },
    ]);
  });
});

describe("zonedInstant", () => {
  it("reads a wall-clock time in the zone", () => {
    expect(zonedInstant("2027-06-05", "19:00", "America/New_York")).toBe(
      "2027-06-05T23:00:00.000Z",
    );
    expect(zonedInstant("2027-01-05", "19:00", "America/New_York")).toBe(
      "2027-01-06T00:00:00.000Z",
    );
    expect(zonedInstant("2027-06-05", "19:00", "UTC")).toBe("2027-06-05T19:00:00.000Z");
  });

  it("lands a time the clocks skip after the change, and a repeated time on its first occurrence", () => {
    // 2027-03-14 in New York: 02:00 jumps to 03:00.
    expect(zonedInstant("2027-03-14", "02:30", "America/New_York")).toBe(
      "2027-03-14T07:30:00.000Z",
    );
    expect(zonedInstant("2027-03-14", "03:30", "America/New_York")).toBe(
      "2027-03-14T07:30:00.000Z",
    );
    // 2026-11-01 in New York: 01:30 happens in EDT first, then in EST.
    expect(zonedInstant("2026-11-01", "01:30", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("refuses malformed days and times", () => {
    expect(zonedInstant("2027-6-5", "19:00", "UTC")).toBeNull();
    expect(zonedInstant("2027-06-05", "24:00", "UTC")).toBeNull();
    expect(zonedInstant("2027-06-05", "7pm", "UTC")).toBeNull();
  });
});

describe("helpers", () => {
  it("steps a day across a month end", () => {
    expect(nextDay("2027-06-30")).toBe("2027-07-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });

  it("writes and reads cue durations", () => {
    expect(durationText(90)).toBe("01:30:00");
    expect(durationText(1440)).toBe("24:00:00");
    expect(durationSeconds("01:30:00")).toBe(5400);
    expect(durationSeconds(null)).toBeNull();
    expect(durationSeconds("90 minutes")).toBeNull();
  });

  it("knows the list kinds", () => {
    expect(isListDraftKind("run_of_show")).toBe(true);
    expect(isListDraftKind("risk_assessment")).toBe(true);
    expect(isListDraftKind("sop")).toBe(false);
  });
});
