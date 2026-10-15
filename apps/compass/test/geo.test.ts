import { describe, expect, it } from "vitest";
import {
  distanceToShapeM,
  evaluateGeofence,
  fixQuality,
  haversineM,
  samplingPlan,
  shapeContains,
  type Geofence,
} from "../src/domain/geo";

// A venue roughly 200 m square near downtown Austin, with a 40 m hole (a neighbor's lot).
const venue: Geofence = {
  id: "g1",
  name: "Main Venue",
  boundary: {
    type: "Polygon",
    coordinates: [
      [
        [-97.745, 30.265],
        [-97.743, 30.265],
        [-97.743, 30.267],
        [-97.745, 30.267],
        [-97.745, 30.265],
      ],
      [
        [-97.7442, 30.2658],
        [-97.7438, 30.2658],
        [-97.7438, 30.2662],
        [-97.7442, 30.2662],
        [-97.7442, 30.2658],
      ],
    ],
  },
};

const lot: Geofence = {
  id: "g2",
  name: "Lots",
  boundary: {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [-97.75, 30.27],
          [-97.749, 30.27],
          [-97.749, 30.271],
          [-97.75, 30.271],
          [-97.75, 30.27],
        ],
      ],
    ],
  },
};

const now = 1_000_000;
const fix = (longitude: number, latitude: number, accuracyM = 10, at = now) => ({
  longitude,
  latitude,
  accuracyM,
  at,
});

describe("geofence", () => {
  it("covers interior and edge points and excludes holes", () => {
    expect(shapeContains(venue.boundary, [-97.7445, 30.2655])).toBe(true);
    expect(shapeContains(venue.boundary, [-97.745, 30.266])).toBe(true);
    expect(shapeContains(venue.boundary, [-97.744, 30.266])).toBe(false);
    expect(shapeContains(venue.boundary, [-97.7442, 30.266])).toBe(true);
    expect(shapeContains(lot.boundary, [-97.7495, 30.2705])).toBe(true);
    expect(shapeContains({ type: "Polygon", coordinates: [] }, [0, 0])).toBe(false);
  });

  it("says inside with the fix quality", () => {
    const status = evaluateGeofence(fix(-97.7445, 30.2655, 30), [venue, lot], now);
    expect(status).toMatchObject({ kind: "inside", quality: "fair" });
    expect(status.kind === "inside" && status.geofence.id).toBe("g1");
  });

  it("says outside with the nearest fence and distance", () => {
    const status = evaluateGeofence(fix(-97.7445, 30.2645), [venue, lot], now);
    expect(status.kind).toBe("outside");
    if (status.kind !== "outside") return;
    expect(status.nearest?.id).toBe("g1");
    expect(status.distanceM).toBeGreaterThan(50);
    expect(status.distanceM).toBeLessThan(60);
  });

  it("cannot decide with no fix, a stale fix or a coarse fix", () => {
    expect(evaluateGeofence(null, [venue], now)).toEqual({ kind: "unknown", reason: "no-fix" });
    expect(evaluateGeofence(fix(-97.7445, 30.2655, 10, now - 3 * 60_000), [venue], now)).toEqual({
      kind: "unknown",
      reason: "stale",
    });
    expect(evaluateGeofence(fix(-97.7445, 30.2655, 500), [venue], now)).toEqual({
      kind: "unknown",
      reason: "coarse",
    });
  });

  it("never blocks a project without a geofence", () => {
    expect(evaluateGeofence(null, [], now)).toEqual({ kind: "unfenced" });
  });

  it("grades fixes and measures distance", () => {
    expect(fixQuality(10)).toBe("good");
    expect(fixQuality(50)).toBe("fair");
    expect(fixQuality(120)).toBe("poor");
    expect(Math.round(haversineM([-97.745, 30.265], [-97.745, 30.266]))).toBe(111);
    expect(distanceToShapeM(venue.boundary, [-97.745, 30.264])).toBeCloseTo(111, 0);
  });
});

describe("battery budget", () => {
  const healthy = { level: 0.8, charging: false, lowPowerMode: false };

  it("samples precisely only while punching", () => {
    expect(
      samplingPlan({
        battery: healthy,
        onShift: false,
        minutesToCall: null,
        punching: true,
        batterySaver: false,
      }),
    ).toEqual({ accuracy: "high", intervalMs: 5_000, distanceM: 0 });
  });

  it("does not sample off shift away from a call time", () => {
    expect(
      samplingPlan({
        battery: healthy,
        onShift: false,
        minutesToCall: 240,
        punching: false,
        batterySaver: false,
      }).accuracy,
    ).toBe("off");
  });

  it("samples around the call time and less often on shift", () => {
    expect(
      samplingPlan({
        battery: healthy,
        onShift: false,
        minutesToCall: 10,
        punching: false,
        batterySaver: false,
      }),
    ).toEqual({ accuracy: "balanced", intervalMs: 60_000, distanceM: 25 });
    expect(
      samplingPlan({
        battery: healthy,
        onShift: true,
        minutesToCall: null,
        punching: false,
        batterySaver: false,
      }).intervalMs,
    ).toBe(300_000);
  });

  it("backs off on a low battery, low power mode or battery saver", () => {
    const low = { level: 0.1, charging: false, lowPowerMode: false };
    for (const plan of [
      samplingPlan({
        battery: low,
        onShift: true,
        minutesToCall: null,
        punching: false,
        batterySaver: false,
      }),
      samplingPlan({
        battery: { ...healthy, lowPowerMode: true },
        onShift: true,
        minutesToCall: null,
        punching: false,
        batterySaver: false,
      }),
      samplingPlan({
        battery: healthy,
        onShift: true,
        minutesToCall: null,
        punching: false,
        batterySaver: true,
      }),
    ]) {
      expect(plan.accuracy).toBe("low");
    }
    expect(
      samplingPlan({
        battery: { ...low, charging: true },
        onShift: true,
        minutesToCall: null,
        punching: false,
        batterySaver: false,
      }).accuracy,
    ).toBe("balanced");
  });
});
