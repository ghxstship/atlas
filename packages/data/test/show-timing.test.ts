import { describe, expect, it } from "vitest";
import {
  CURFEW_WARNING_SECONDS,
  cueProgress,
  showClock,
  type TimedCue,
} from "../src/show-timing.ts";

const NOW = new Date("2027-06-05T23:10:00Z");

const cue = (position: number, over: Partial<TimedCue> = {}): TimedCue => ({
  position,
  plannedAt: `2027-06-05T23:${String(position * 2).padStart(2, "0")}:00Z`,
  durationSeconds: 60,
  calledAt: null,
  standbyAt: null,
  startTbc: false,
  ...over,
});

describe("cueProgress", () => {
  it("orders the cues by position itself and answers in indices of that order", () => {
    const cues = [
      cue(3),
      cue(1, { calledAt: "2027-06-05T23:02:10Z" }),
      cue(2),
    ];
    expect(cueProgress(cues, NOW)).toEqual({
      current: 0,
      next: 1,
      nextInSeconds: -360,
      elapsedSeconds: 470,
      complete: false,
      standby: false,
      skipped: [],
    });
  });

  it("takes the standby cue as next, ahead of the cue after the latest call", () => {
    const cues = [cue(1, { calledAt: "2027-06-05T23:02:00Z" }), cue(2), cue(3, { standbyAt: "2027-06-05T23:09:00Z" })];
    expect(cueProgress(cues, NOW)).toMatchObject({ current: 0, next: 2, standby: true, complete: false });
  });

  it("marks cues jumped past as skipped, and the cue after the latest call as next", () => {
    const cues = [
      cue(1, { calledAt: "2027-06-05T23:02:00Z" }),
      cue(2),
      cue(3, { calledAt: "2027-06-05T23:06:00Z" }),
      cue(4),
    ];
    expect(cueProgress(cues, NOW)).toMatchObject({ current: 2, next: 3, skipped: [1], standby: false });
  });

  it("takes the most recent call as current after a back-call", () => {
    const cues = [
      cue(1, { calledAt: "2027-06-05T23:02:00Z" }),
      cue(2, { calledAt: "2027-06-05T23:09:00Z" }),
      cue(3, { calledAt: "2027-06-05T23:06:00Z" }),
      cue(4),
    ];
    // The caller went back for cue 2 after cue 3; next is still the first uncalled cue after cue 3.
    expect(cueProgress(cues, NOW)).toMatchObject({ current: 1, next: 3, skipped: [] });
  });

  it("is complete only when nothing uncalled follows the latest call and no cue is on standby", () => {
    const allButSkipped = [
      cue(1, { calledAt: "2027-06-05T23:02:00Z" }),
      cue(2),
      cue(3, { calledAt: "2027-06-05T23:06:00Z" }),
    ];
    expect(cueProgress(allButSkipped, NOW)).toMatchObject({ complete: true, next: 1, skipped: [1] });
    const standbyOnSkipped = allButSkipped.map((c) =>
      c.position === 2 ? { ...c, standbyAt: "2027-06-05T23:09:00Z" } : c,
    );
    expect(cueProgress(standbyOnSkipped, NOW)).toMatchObject({ complete: false, next: 1, standby: true });
    expect(cueProgress([cue(1), cue(2)], NOW)).toMatchObject({ current: -1, next: 0, complete: false });
    expect(cueProgress([], NOW)).toMatchObject({ current: -1, next: -1, complete: false });
  });

  it("has no countdown for a next cue without a plan", () => {
    expect(cueProgress([cue(1, { plannedAt: null })], NOW).nextInSeconds).toBeNull();
  });
});

describe("showClock", () => {
  it("has not started before the first call", () => {
    const clock = showClock([cue(1), cue(2)], { curfewAt: null }, new Date("2027-06-05T23:00:00Z"));
    expect(clock).toMatchObject({ startedAt: null, elapsedSeconds: null, overrunSeconds: 0, curfewRisk: "none" });
    // Before the first cue is due nothing is late; once it is due the show runs behind.
    expect(showClock([cue(1), cue(2)], { curfewAt: null }, NOW).overrunSeconds).toBe(480);
  });

  it("runs behind by the later of the last call's lateness and the next cue's", () => {
    const cues = [cue(1, { calledAt: "2027-06-05T23:05:20Z" }), cue(2), cue(3)];
    const clock = showClock(cues, { curfewAt: null }, NOW);
    // Cue 1 was called 3:20 late; cue 2 was due 23:04, so now it is 6:00 late.
    expect(clock.overrunSeconds).toBe(360);
    expect(clock.startedAt).toBe("2027-06-05T23:05:20.000Z");
    expect(clock.elapsedSeconds).toBe(280);
    expect(clock.plannedEndAt).toBe("2027-06-05T23:07:00.000Z");
    expect(clock.projectedEndAt).toBe("2027-06-05T23:13:00.000Z");
  });

  it("runs ahead when the last call came early and the next cue is not yet due", () => {
    const cues = [cue(1, { plannedAt: "2027-06-05T23:12:00Z", calledAt: "2027-06-05T23:09:00Z" }), cue(8)];
    expect(showClock(cues, { curfewAt: null }, NOW).overrunSeconds).toBe(-180);
  });

  it("ignores the plan of a next cue whose time is to be confirmed", () => {
    const cues = [cue(1, { calledAt: "2027-06-05T23:02:00Z" }), cue(2, { startTbc: true }), cue(3)];
    expect(showClock(cues, { curfewAt: null }, NOW).overrunSeconds).toBe(0);
    expect(showClock([cue(1, { startTbc: true })], { curfewAt: null }, NOW).overrunSeconds).toBeNull();
  });

  it("freezes the elapsed time at the last call once complete", () => {
    const cues = [cue(1, { calledAt: "2027-06-05T23:02:00Z" }), cue(2, { calledAt: "2027-06-05T23:05:00Z" })];
    expect(showClock(cues, { curfewAt: null }, NOW).elapsedSeconds).toBe(180);
  });

  it("weighs the projected end against the curfew: none, ok, near and over", () => {
    const cues = [cue(1, { calledAt: "2027-06-05T23:02:00Z" }), cue(2)];
    const at = (curfewAt: string | null) => showClock(cues, { curfewAt }, NOW);
    // Planned end 23:05, six minutes behind: projected 23:11.
    expect(at(null).curfewRisk).toBe("none");
    expect(at("2027-06-06T00:00:00Z")).toMatchObject({ curfewRisk: "ok", curfewMarginSeconds: 2940 });
    expect(at("2027-06-05T23:20:00Z")).toMatchObject({ curfewRisk: "near", curfewMarginSeconds: 540 });
    expect(540).toBeLessThanOrEqual(CURFEW_WARNING_SECONDS);
    expect(at("2027-06-05T23:10:00Z")).toMatchObject({ curfewRisk: "over", curfewMarginSeconds: -60 });
    expect(showClock([cue(1, { plannedAt: null })], { curfewAt: "2027-06-06T00:00:00Z" }, NOW).curfewRisk).toBe(
      "none",
    );
  });
});
