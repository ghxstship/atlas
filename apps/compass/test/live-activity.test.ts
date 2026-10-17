import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ClockSnapshot } from "../src/domain/clock";
import {
  activityChanged,
  activityContent,
  parseContext,
  queuedPunchMutation,
  serializeContext,
} from "../src/domain/liveActivity";

const T0 = Date.parse("2026-10-17T08:00:00Z");
const snap = (over: Partial<ClockSnapshot>): ClockSnapshot => ({
  state: "out",
  onSince: null,
  breakSince: null,
  breakMs: 0,
  projectId: null,
  shiftId: null,
  ...over,
});
const ctx = {
  projectId: "p1",
  shiftId: "s1",
  membershipId: "m1",
  engagementId: null,
  source: "Mobile" as const,
};
const clock = { wallNow: () => T0 + 600_000, monotonicNow: () => 50_000, bootId: () => "boot-1" };

describe("activityContent", () => {
  it("shows nothing when clocked out", () => {
    expect(activityContent(snap({}), T0)).toBeNull();
  });

  it("counts worked time up from clock in plus breaks taken", () => {
    const content = activityContent(
      snap({ state: "on", onSince: T0, breakMs: 15 * 60_000 }),
      T0 + 3 * 3600_000,
    );
    expect(content).toEqual({
      state: "on",
      onShiftSince: T0,
      segmentStart: T0 + 15 * 60_000,
      workedBaseSeconds: 0,
      breakSince: null,
    });
  });

  it("freezes worked time during a break", () => {
    const content = activityContent(
      snap({ state: "break", onSince: T0, breakSince: T0 + 2 * 3600_000, breakMs: 10 * 60_000 }),
      T0 + 2.5 * 3600_000,
    );
    expect(content).toMatchObject({
      state: "break",
      workedBaseSeconds: 110 * 60,
      breakSince: T0 + 7_200_000,
    });
  });

  it("changes only when what the activity shows changes", () => {
    const a = activityContent(snap({ state: "on", onSince: T0 }), T0);
    const b = activityContent(snap({ state: "on", onSince: T0 }), T0 + 60_000);
    expect(activityChanged(a, b)).toBe(false);
    expect(activityChanged(null, a)).toBe(true);
    expect(activityChanged(a, null)).toBe(true);
    expect(activityChanged(null, null)).toBe(false);
    const onBreak = activityContent(
      snap({ state: "break", onSince: T0, breakSince: T0 + 1000 }),
      T0,
    );
    expect(activityChanged(a, onBreak)).toBe(true);
  });
});

describe("lock screen punches", () => {
  it("round-trips the punch context and refuses a malformed one", () => {
    expect(parseContext(serializeContext(ctx))).toEqual(ctx);
    expect(parseContext("not json")).toBeNull();
    expect(parseContext(JSON.stringify({ projectId: "p1" }))).toBeNull();
    expect(
      parseContext(JSON.stringify({ projectId: "p1", membershipId: "m", engagementId: "e" })),
    ).toBeNull();
    expect(parseContext(JSON.stringify({ membershipId: "m" }))).toBeNull();
  });

  it("becomes the same record_punch an in-app punch queues, keyed by the intent's id", () => {
    const m = queuedPunchMutation(
      {
        id: "0199f0a0-0000-7000-8000-000000000001",
        kind: "Break Start",
        at: T0,
        context: serializeContext(ctx),
      },
      clock,
    );
    expect(m).toMatchObject({
      op: "rpc",
      target: "app.record_punch",
      rowId: "0199f0a0-0000-7000-8000-000000000001",
      policy: "append",
      payload: {
        p_punch_id: "0199f0a0-0000-7000-8000-000000000001",
        p_punch_kind: "Break Start",
        p_device_time: "2026-10-17T08:00:00.000Z",
        p_project_id: "p1",
        p_shift_id: "s1",
        p_membership_id: "m1",
        p_engagement_id: null,
        p_latitude: null,
        boot_id: "boot-1",
        // Ten minutes old by the wall clock, placed on this session's monotonic clock.
        monotonic_at: 50_000 - 600_000,
      },
    });
  });

  it("drops a punch with no context or an unknown kind", () => {
    expect(queuedPunchMutation({ id: "x", kind: "Out", at: T0, context: "" }, clock)).toBeNull();
    expect(
      queuedPunchMutation(
        { id: "x", kind: "Lunch" as "Out", at: T0, context: serializeContext(ctx) },
        clock,
      ),
    ).toBeNull();
    expect(
      queuedPunchMutation(
        { id: "x", kind: "Out", at: Number.NaN, context: serializeContext(ctx) },
        clock,
      ),
    ).toBeNull();
  });
});

describe("native declarations", () => {
  const block = (path: string) => {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    return text.slice(
      text.indexOf("// BEGIN SHARED DECLARATIONS"),
      text.indexOf("// END SHARED DECLARATIONS"),
    );
  };

  it("keeps the module's attributes and queue identical to the widget's, which ActivityKit matches by shape", () => {
    const widget = block("../targets/ClockActivity/_shared/ClockActivityAttributes.swift");
    expect(widget).toContain("struct ClockActivityAttributes: ActivityAttributes");
    expect(block("../modules/compass-live-activity/ios/ClockActivityAttributes.swift")).toBe(
      widget,
    );
  });

  it("declares the App Group the queue uses in app.json and the widget target", () => {
    const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as {
      expo: { ios: { entitlements: Record<string, string[]>; infoPlist: Record<string, unknown> } };
    };
    expect(app.expo.ios.entitlements["com.apple.security.application-groups"]).toEqual([
      "group.pro.ghxstship.compass",
    ]);
    expect(app.expo.ios.infoPlist["NSSupportsLiveActivities"]).toBe(true);
    expect(block("../targets/ClockActivity/_shared/ClockActivityAttributes.swift")).toContain(
      'appGroup = "group.pro.ghxstship.compass"',
    );
  });
});
