import { stampEvent, type DeviceClock } from "@xos/sync";
import { describe, expect, it } from "vitest";
import {
  AUTO_CLOSE_MS,
  buildPunch,
  checkPunch,
  deriveClock,
  forgottenClockOut,
  formatElapsed,
  primaryPunch,
  secondaryPunches,
  workedMs,
  type Punch,
  type PunchKind,
} from "../src/domain/clock";
import type { Geofence } from "../src/domain/geo";

const T0 = Date.UTC(2026, 9, 14, 14, 0, 0);
const min = 60_000;

function punch(kind: PunchKind, at: number, id = `p-${at}`): Punch {
  return {
    id,
    punch_kind: kind,
    device_at: new Date(at).toISOString(),
    project_id: "proj-1",
    shift_id: "shift-1",
    membership_id: "mem-1",
    engagement_id: null,
    source: "Mobile",
  };
}

describe("clock state", () => {
  it("is out with no punches", () => {
    expect(deriveClock([], T0).state).toBe("out");
  });

  it("replays in, break and out in device-time order", () => {
    const punches = [
      punch("Break End", T0 + 90 * min),
      punch("In", T0),
      punch("Break Start", T0 + 60 * min),
    ];
    const snap = deriveClock(punches, T0 + 120 * min);
    expect(snap).toMatchObject({
      state: "on",
      onSince: T0,
      breakMs: 30 * min,
      projectId: "proj-1",
      shiftId: "shift-1",
    });
    expect(workedMs(snap, T0 + 120 * min)).toBe(90 * min);
    expect(deriveClock([...punches, punch("Out", T0 + 130 * min)], T0 + 140 * min).state).toBe(
      "out",
    );
  });

  it("subtracts a running break from worked time", () => {
    const snap = deriveClock([punch("In", T0), punch("Break Start", T0 + 60 * min)], T0 + 75 * min);
    expect(snap.state).toBe("break");
    expect(workedMs(snap, T0 + 75 * min)).toBe(60 * min);
    expect(workedMs(deriveClock([], T0), T0)).toBe(0);
  });

  it("ignores a second clock-in from another device while already in", () => {
    const snap = deriveClock([punch("In", T0, "a"), punch("In", T0 + 5 * min, "b")], T0 + 10 * min);
    expect(snap.onSince).toBe(T0);
  });

  it("ignores out-of-order break punches", () => {
    const snap = deriveClock(
      [punch("Break Start", T0), punch("Break End", T0 + min)],
      T0 + 2 * min,
    );
    expect(snap.state).toBe("out");
  });

  it("closes a forgotten clock-out at 16 hours and flags it", () => {
    const punches = [punch("In", T0)];
    expect(deriveClock(punches, T0 + AUTO_CLOSE_MS - 1).state).toBe("on");
    expect(deriveClock(punches, T0 + AUTO_CLOSE_MS).state).toBe("out");
    expect(forgottenClockOut(punches, T0 + AUTO_CLOSE_MS)).toBe(true);
    expect(
      forgottenClockOut([...punches, punch("Out", T0 + 8 * 60 * min)], T0 + AUTO_CLOSE_MS),
    ).toBe(false);
    const nextDay = [punch("In", T0), punch("In", T0 + AUTO_CLOSE_MS + min)];
    expect(deriveClock(nextDay, T0 + AUTO_CLOSE_MS + 2 * min).onSince).toBe(
      T0 + AUTO_CLOSE_MS + min,
    );
    expect(
      forgottenClockOut(
        [punch("In", T0), punch("Break Start", T0 + AUTO_CLOSE_MS + min)],
        T0 + AUTO_CLOSE_MS + 2 * min,
      ),
    ).toBe(false);
  });

  it("leads with one action that follows the state", () => {
    expect(primaryPunch("out")).toBe("In");
    expect(primaryPunch("on")).toBe("Out");
    expect(primaryPunch("break")).toBe("Break End");
    expect(secondaryPunches("on")).toEqual(["Break Start"]);
    expect(secondaryPunches("break")).toEqual(["Out"]);
    expect(secondaryPunches("out")).toEqual([]);
  });

  it("formats the shift timer", () => {
    expect(formatElapsed(3 * 3600_000 + 42 * min + 10_000)).toBe("3:42:10");
    expect(formatElapsed(-5)).toBe("0:00:00");
  });
});

describe("punch rules", () => {
  const out = deriveClock([], T0);
  const on = deriveClock([punch("In", T0)], T0 + min);
  const onBreak = deriveClock([punch("In", T0), punch("Break Start", T0 + min)], T0 + 2 * min);
  const open = { requireGeofence: false, requireShift: false };
  const strict = { requireGeofence: true, requireShift: true };
  const inside = {
    kind: "inside",
    geofence: { id: "g", name: "g", boundary: { type: "Polygon", coordinates: [] } },
    quality: "good",
  } as const;

  it("refuses a double clock-in", () => {
    expect(checkPunch("In", on, inside, open, true)).toBe("already-in");
  });

  it("enforces on-site and rostered policies only for clock-in", () => {
    expect(checkPunch("In", out, inside, strict, false)).toBe("not-rostered");
    expect(
      checkPunch(
        "In",
        out,
        { kind: "outside", nearest: null, distanceM: 400, quality: "good" },
        strict,
        true,
      ),
    ).toBe("outside-geofence");
    expect(checkPunch("In", out, { kind: "unknown", reason: "no-fix" }, strict, true)).toBe(
      "location-unknown",
    );
    expect(checkPunch("In", out, { kind: "unfenced" }, strict, true)).toBeNull();
    expect(
      checkPunch(
        "In",
        out,
        { kind: "outside", nearest: null, distanceM: 400, quality: "good" },
        open,
        false,
      ),
    ).toBeNull();
    expect(
      checkPunch(
        "Out",
        on,
        { kind: "outside", nearest: null, distanceM: 400, quality: "good" },
        strict,
        false,
      ),
    ).toBeNull();
  });

  it("checks break and out against the state", () => {
    expect(checkPunch("Break Start", out, inside, open, true)).toBe("not-clocked-in");
    expect(checkPunch("Break Start", onBreak, inside, open, true)).toBe("already-on-break");
    expect(checkPunch("Break Start", on, inside, open, true)).toBeNull();
    expect(checkPunch("Break End", on, inside, open, true)).toBe("not-on-break");
    expect(checkPunch("Break End", onBreak, inside, open, true)).toBeNull();
    expect(checkPunch("Out", out, inside, open, true)).toBe("not-clocked-in");
    expect(checkPunch("Out", onBreak, inside, open, true)).toBeNull();
  });
});

describe("queued punch", () => {
  const clock: DeviceClock = { wallNow: () => T0, monotonicNow: () => 5_000, bootId: () => "b1" };
  const anchor = { serverMs: T0 - 4_000, monotonicMs: 1_000, bootId: "b1" };
  const fence: Geofence = {
    id: "g1",
    name: "Venue",
    boundary: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    },
  };

  it("carries device time, monotonic offset, fix quality and the device geofence verdict", () => {
    const m = buildPunch(
      "In",
      {
        projectId: "proj-1",
        shiftId: "shift-1",
        membershipId: "mem-1",
        engagementId: null,
        source: "Mobile",
      },
      stampEvent(clock, anchor),
      { longitude: 0.5, latitude: 0.5, accuracyM: 8, at: T0 },
      [fence],
      T0,
      () => "punch-1",
    );
    expect(m).toMatchObject({
      op: "rpc",
      target: "record_punch",
      table: "clock_punches",
      rowId: "punch-1",
      policy: "append",
    });
    expect(m.payload).toMatchObject({
      punch_kind: "In",
      device_at: new Date(T0).toISOString(),
      monotonic_offset_ms: 4_000,
      accuracy_m: 8,
      geofence_id: "g1",
      device_geofence_status: "inside",
      device_needs_review: false,
      membership_id: "mem-1",
      engagement_id: null,
    });
    expect(m.optimistic).toEqual(m.payload);
  });

  it("punches an external worker by engagement and flags an unanchored offline punch", () => {
    const m = buildPunch(
      "Out",
      {
        projectId: "proj-1",
        shiftId: null,
        membershipId: null,
        engagementId: "eng-1",
        source: "Kiosk",
        kioskDeviceId: "k1",
        photoUri: "file:///p.jpg",
      },
      stampEvent(clock, null),
      null,
      [],
      T0,
    );
    expect(m.payload).toMatchObject({
      engagement_id: "eng-1",
      membership_id: null,
      latitude: null,
      device_geofence_status: "unfenced",
      device_needs_review: true,
      kiosk_device_id: "k1",
      photo_uri: "file:///p.jpg",
    });
    expect(typeof m.rowId).toBe("string");
  });

  it("refuses a punch naming both or neither of membership and engagement", () => {
    const event = stampEvent(clock, null);
    expect(() =>
      buildPunch(
        "In",
        { projectId: "p", shiftId: null, membershipId: "m", engagementId: "e", source: "Mobile" },
        event,
        null,
        [],
        T0,
      ),
    ).toThrow("exactly one");
    expect(() =>
      buildPunch(
        "In",
        { projectId: "p", shiftId: null, membershipId: null, engagementId: null, source: "Mobile" },
        event,
        null,
        [],
        T0,
      ),
    ).toThrow("exactly one");
  });
});
