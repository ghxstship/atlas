/**
 * Compass outside the app (Section 13 Platform features, A65-011 part 4): the next cue in the Live
 * Activity, the home screen widgets' payload and the Android ongoing notification.
 */
import { describe, expect, it } from "vitest";
import type { ClockSnapshot } from "../src/domain/clock";
import {
  ongoingContent,
  widgetPayload,
  WIDGET_SHIFTS,
  type GlanceCue,
  type GlanceShift,
  type Translate,
} from "../src/domain/glance";
import {
  activityChanged,
  activityContent,
  CUE_ACTIVITY_LATE_MS,
  CUE_ACTIVITY_LEAD_MS,
  cueDue,
} from "../src/domain/liveActivity";

const T0 = Date.parse("2027-06-11T23:00:00Z");
const snap = (over: Partial<ClockSnapshot>): ClockSnapshot => ({
  state: "out",
  onSince: null,
  breakSince: null,
  breakMs: 0,
  projectId: null,
  shiftId: null,
  ...over,
});
/** Catalog stand-in: the key and its values, so each test sees which message and arguments were used. */
const t: Translate = (key, values) =>
  values
    ? `${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key;
/** Times as HH:MM in the given zone, as the app formats them. */
const formatTime = (iso: string, zone: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(
    new Date(iso),
  );
const cue: GlanceCue = {
  label: "Headliner",
  at: T0 + 45 * 60_000,
  project: "Pier Week",
  zone: "America/Los_Angeles",
};

describe("the next cue in the Live Activity", () => {
  it("shows the next cue beside the shift timer", () => {
    const content = activityContent(snap({ state: "on", onSince: T0 - 3600_000 }), T0, cue);
    expect(content).toMatchObject({ state: "on", nextCueLabel: "Headliner", nextCueAt: cue.at });
    const onBreak = activityContent(
      snap({ state: "break", onSince: T0 - 3600_000, breakSince: T0 - 60_000 }),
      T0,
      cue,
    );
    expect(onBreak).toMatchObject({ state: "break", nextCueLabel: "Headliner" });
  });

  it("shows the cue alone while clocked out once it is close, and nothing otherwise", () => {
    expect(activityContent(snap({}), T0, cue)).toEqual({
      state: "cue",
      onShiftSince: cue.at,
      segmentStart: cue.at,
      workedBaseSeconds: 0,
      breakSince: null,
      nextCueLabel: "Headliner",
      nextCueAt: cue.at,
    });
    const far = { ...cue, at: T0 + CUE_ACTIVITY_LEAD_MS + 1 };
    expect(activityContent(snap({}), T0, far)).toBeNull();
    expect(cueDue({ ...cue, at: T0 - CUE_ACTIVITY_LATE_MS }, T0)).toBe(true);
    expect(cueDue({ ...cue, at: T0 - CUE_ACTIVITY_LATE_MS - 1 }, T0)).toBe(false);
    expect(cueDue(null, T0)).toBe(false);
  });

  it("updates the activity when the next cue changes", () => {
    const base = activityContent(snap({ state: "on", onSince: T0 }), T0, cue);
    const later = activityContent(snap({ state: "on", onSince: T0 }), T0, {
      ...cue,
      label: "Encore",
    });
    expect(activityChanged(base, later)).toBe(true);
    expect(
      activityChanged(base, activityContent(snap({ state: "on", onSince: T0 }), T0, cue)),
    ).toBe(false);
    expect(activityChanged(base, activityContent(snap({ state: "on", onSince: T0 }), T0))).toBe(
      true,
    );
  });
});

describe("the home screen widgets", () => {
  const shift = (id: string, startsAt: string, endsAt: string, zone: string): GlanceShift => ({
    id,
    title: "Rigger",
    startsAt,
    endsAt,
    zone,
    org: "Harbor Stages",
  });

  it("lists today's shifts soonest first, each time on its own calendar, with the next cue", () => {
    const payload = widgetPayload(
      [
        shift("la", "2027-06-12T03:00:00Z", "2027-06-12T07:00:00Z", "America/Los_Angeles"),
        shift("ny", "2027-06-11T14:00:00Z", "2027-06-11T22:00:00Z", "America/New_York"),
      ],
      cue,
      t,
      formatTime,
      "compass://today",
    );
    expect(payload.shifts.map((s) => s.id)).toEqual(["ny", "la"]);
    // 14:00 UTC is 10:00 in New York; 03:00 UTC on the 12th is 20:00 on the 11th in Los Angeles.
    expect(payload.shifts[0]?.time).toBe("compass.schedule.timeRange(start=10:00,end=18:00)");
    expect(payload.shifts[1]?.time).toBe("compass.schedule.timeRange(start=20:00,end=00:00)");
    expect(payload.shifts[0]).toMatchObject({
      org: "Harbor Stages",
      endsAt: Date.parse("2027-06-11T22:00:00Z"),
    });
    expect(payload.cue).toEqual({ label: "Headliner", at: cue.at, project: "Pier Week" });
    expect(payload).toMatchObject({
      title: "compass.glance.today",
      empty: "compass.today.noShifts",
      nextCueTitle: "compass.today.nextCue",
      noCue: "compass.glance.noCue",
      link: "compass://today",
    });
  });

  it("keeps the payload small and says when there is no cue", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      shift(`s${i}`, `2027-06-11T1${i}:00:00Z`, `2027-06-11T1${i}:30:00Z`, "UTC"),
    );
    const payload = widgetPayload(many, null, t, formatTime, "compass://today");
    expect(payload.shifts).toHaveLength(WIDGET_SHIFTS);
    expect(payload.cue).toBeNull();
  });
});

describe("the Android ongoing notification", () => {
  it("names the running shift, since when, and the next cue", () => {
    const content = ongoingContent(
      snap({ state: "on", onSince: Date.parse("2027-06-11T19:02:00Z") }),
      cue,
      "Pier Week",
      T0,
      t,
      formatTime,
      "America/Los_Angeles",
    );
    expect(content).toEqual({
      title: "compass.glance.onShiftTitle(project=Pier Week)",
      body: "compass.glance.since(time=12:02) · compass.glance.cueLine(cue=Headliner,time=16:45)",
    });
  });

  it("names the break, and leaves out a cue long past", () => {
    const content = ongoingContent(
      snap({
        state: "break",
        onSince: Date.parse("2027-06-11T19:02:00Z"),
        breakSince: Date.parse("2027-06-11T22:30:00Z"),
      }),
      { ...cue, at: T0 - 2 * 3600_000 },
      "Pier Week",
      T0,
      t,
      formatTime,
      "America/Los_Angeles",
    );
    expect(content).toEqual({
      title: "compass.glance.onBreakTitle(project=Pier Week)",
      body: "compass.glance.since(time=15:30)",
    });
  });

  it("shows a close cue while clocked out and nothing when there is nothing to show", () => {
    expect(ongoingContent(snap({}), cue, "", T0, t, formatTime, "UTC")).toEqual({
      title: "compass.glance.cueTitle(cue=Headliner)",
      body: "compass.glance.cueBody(project=Pier Week,time=16:45)",
    });
    expect(
      ongoingContent(snap({}), { ...cue, project: null }, "", T0, t, formatTime, "UTC")?.body,
    ).toBe("compass.glance.cueLine(cue=Headliner,time=16:45)");
    expect(
      ongoingContent(snap({}), { ...cue, at: T0 + 5 * 3600_000 }, "", T0, t, formatTime, "UTC"),
    ).toBeNull();
    expect(ongoingContent(snap({}), null, "", T0, t, formatTime, "UTC")).toBeNull();
  });
});
