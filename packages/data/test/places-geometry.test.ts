import { describe, expect, it } from "vitest";
import {
  feetPerPixel,
  feetToMeters,
  metersToFeet,
  parsePointAnchor,
  pointAnchor,
  polygonSqFt,
  polylineFeet,
  sqFtToSqM,
  toPixels,
} from "../src/places-geometry.ts";

/** The pgTAP 2901 fixture: a 2000 by 1000 px drawing calibrated (0.1, 0.5) to (0.6, 0.5) as 50 ft. */
const SIZE = { widthPx: 2000, heightPx: 1000 };
const CALIBRATION = { ax: 0.1, ay: 0.5, bx: 0.6, by: 0.5, feet: 50 };

describe("plan-space geometry (ADR 0140 D4)", () => {
  it("measures in the drawing's pixels, as app.site_plan_shape_geometry does", () => {
    expect(toPixels([0.5, 0.5], SIZE)).toEqual([1000, 500]);
    expect(feetPerPixel(CALIBRATION, SIZE)).toBeCloseTo(0.05, 10);
    expect(
      polylineFeet(
        [
          [0.1, 0.1],
          [0.1, 0.6],
        ],
        SIZE,
        CALIBRATION,
      ),
    ).toBeCloseTo(25, 10);
    const square = [
      [0.1, 0.2],
      [0.3, 0.2],
      [0.3, 0.6],
      [0.1, 0.6],
    ] as const;
    expect(polygonSqFt(square, SIZE, CALIBRATION)).toBeCloseTo(400, 10);
    expect(polylineFeet(square, SIZE, CALIBRATION, true)).toBeCloseTo(80, 10);
  });

  it("gives no measurement without a usable scale or enough points", () => {
    expect(feetPerPixel({ ...CALIBRATION, bx: 0.1 }, SIZE)).toBeNull();
    expect(polylineFeet([[0.1, 0.1]], SIZE, CALIBRATION)).toBeNull();
    expect(
      polygonSqFt(
        [
          [0.1, 0.1],
          [0.2, 0.2],
        ],
        SIZE,
        CALIBRATION,
      ),
    ).toBeNull();
  });

  it("converts for metric viewers at 0.3048", () => {
    expect(feetToMeters(25).toFixed(2)).toBe("7.62");
    expect(sqFtToSqM(400).toFixed(2)).toBe("37.16");
    expect(metersToFeet(0.3048)).toBeCloseTo(1, 10);
  });

  it("writes point anchors in the one canonical form the database takes", () => {
    expect(pointAnchor([0.42, 0.1])).toBe("point:0.4200,0.1000");
    expect(pointAnchor([1.2, -0.1])).toBe("point:1.0000,0.0000");
    expect(parsePointAnchor("point:0.4200,0.1000")).toEqual([0.42, 0.1]);
    expect(parsePointAnchor("point:0.42,0.1")).toBeNull();
    expect(parsePointAnchor(null)).toBeNull();
  });
});
