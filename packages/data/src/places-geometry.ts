/**
 * Plan-space geometry (ADR 0140 D4). Pins and shapes sit at fractions of the drawing's width and height (x from the
 * left, y from the top, 0 to 1). Lengths and areas are measured in the drawing's own pixels and scaled by one
 * calibrated distance in feet, exactly as app.site_plan_shape_geometry measures them (migration 2901), so the Atlas
 * measure tool and the database give the same numbers. Feet is the stored unit; metric viewers convert at 0.3048.
 * Pure functions, safe in the browser.
 */

export type PlanPoint = readonly [x: number, y: number];

export interface PlanSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface PlanCalibration {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  /** The real distance between the two points, in feet. */
  readonly feet: number;
}

const METERS_PER_FOOT = 0.3048;

/** A plan-space point in the drawing's pixels. */
export function toPixels(point: PlanPoint, size: PlanSize): PlanPoint {
  return [point[0] * size.widthPx, point[1] * size.heightPx];
}

/** Feet per pixel of a calibration on a drawing, or null when the two points coincide in pixels. */
export function feetPerPixel(calibration: PlanCalibration, size: PlanSize): number | null {
  const [ax, ay] = toPixels([calibration.ax, calibration.ay], size);
  const [bx, by] = toPixels([calibration.bx, calibration.by], size);
  const px = Math.hypot(bx - ax, by - ay);
  return px > 0 && calibration.feet > 0 ? calibration.feet / px : null;
}

/** The length in feet of a polyline (a route or barrier), or of a closed ring when `closed` (an area's perimeter). */
export function polylineFeet(
  points: readonly PlanPoint[],
  size: PlanSize,
  calibration: PlanCalibration,
  closed = false,
): number | null {
  const scale = feetPerPixel(calibration, size);
  if (scale === null || points.length < 2) return null;
  const ring = closed ? [...points, points[0] as PlanPoint] : points;
  let px = 0;
  for (let i = 1; i < ring.length; i += 1) {
    const [x0, y0] = toPixels(ring[i - 1] as PlanPoint, size);
    const [x1, y1] = toPixels(ring[i] as PlanPoint, size);
    px += Math.hypot(x1 - x0, y1 - y0);
  }
  return px * scale;
}

/** The area in square feet of a polygon (the shoelace formula in pixels), or null with fewer than three corners. */
export function polygonSqFt(
  points: readonly PlanPoint[],
  size: PlanSize,
  calibration: PlanCalibration,
): number | null {
  const scale = feetPerPixel(calibration, size);
  if (scale === null || points.length < 3) return null;
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = toPixels(points[i] as PlanPoint, size);
    const [x1, y1] = toPixels(points[(i + 1) % points.length] as PlanPoint, size);
    twice += x0 * y1 - x1 * y0;
  }
  return (Math.abs(twice) / 2) * scale * scale;
}

/** Feet to meters, and square feet to square meters, for metric viewers. */
export function feetToMeters(feet: number): number {
  return feet * METERS_PER_FOOT;
}

export function sqFtToSqM(sqFt: number): number {
  return sqFt * METERS_PER_FOOT * METERS_PER_FOOT;
}

/** A distance typed in meters, as the feet the plan stores. */
export function metersToFeet(meters: number): number {
  return meters / METERS_PER_FOOT;
}

/**
 * The one form of a point note's anchor (ADR 0140 D5): 'point:<x>,<y>' with exactly four decimals, so two clients
 * always find the same thread at a point. The database refuses any other anchor on a plan (site_plan_anchor).
 */
export function pointAnchor(point: PlanPoint): string {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return `point:${clamp(point[0]).toFixed(4)},${clamp(point[1]).toFixed(4)}`;
}

/** The point of a point anchor, or null for any other anchor. */
export function parsePointAnchor(anchor: string | null): PlanPoint | null {
  const match = /^point:(0\.\d{4}|1\.0000),(0\.\d{4}|1\.0000)$/.exec(anchor ?? "");
  return match ? [Number(match[1]), Number(match[2])] : null;
}
