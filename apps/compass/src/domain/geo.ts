/**
 * Geofence evaluation on device (Section 13: geofence evaluation runs on device and is re-verified on the
 * server) and the battery budget for location sampling.
 *
 * Geofences arrive as GeoJSON (app.geofence_shapes). Coordinates are [longitude, latitude] in WGS 84.
 */

export type Position = readonly [longitude: number, latitude: number];
export type LinearRing = readonly Position[];

export type GeoShape =
  | { readonly type: "Polygon"; readonly coordinates: readonly LinearRing[] }
  | { readonly type: "MultiPolygon"; readonly coordinates: readonly (readonly LinearRing[])[] };

export interface Geofence {
  readonly id: string;
  readonly name: string;
  readonly boundary: GeoShape;
}

/**
 * A stored geofence boundary as a shape. The REST downloader stores GeoJSON objects; PowerSync stores the
 * text of ST_AsGeoJSON (packages/sync/sync-rules.yaml). Anything that is not a Polygon or MultiPolygon is
 * null, so a damaged shape is skipped instead of breaking the clock.
 */
export function parseGeoShape(value: unknown): GeoShape | null {
  let shape: unknown = value;
  if (typeof value === "string") {
    try {
      shape = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof shape !== "object" || shape === null) return null;
  const { type, coordinates } = shape as { type?: unknown; coordinates?: unknown };
  return (type === "Polygon" || type === "MultiPolygon") && Array.isArray(coordinates)
    ? (shape as GeoShape)
    : null;
}

export interface LocationFix {
  readonly longitude: number;
  readonly latitude: number;
  /** Horizontal accuracy radius in meters. */
  readonly accuracyM: number;
  /** Device wall time of the fix, in milliseconds. */
  readonly at: number;
}

export type FixQuality = "good" | "fair" | "poor";

export type GeofenceStatus =
  | { readonly kind: "inside"; readonly geofence: Geofence; readonly quality: FixQuality }
  | {
      readonly kind: "outside";
      readonly nearest: Geofence | null;
      readonly distanceM: number | null;
      readonly quality: FixQuality;
    }
  /** No fix yet, the fix is too old, or too coarse to decide. */
  | { readonly kind: "unknown"; readonly reason: "no-fix" | "stale" | "coarse" }
  /** The project has no geofence, so location is recorded but never blocks. */
  | { readonly kind: "unfenced" };

const EARTH_RADIUS_M = 6_371_008.8;
/** A fix older than this is not used to decide on site. */
export const FIX_MAX_AGE_MS = 2 * 60_000;
/** A fix coarser than this cannot decide inside or outside. */
export const FIX_MAX_ACCURACY_M = 150;

export function fixQuality(accuracyM: number): FixQuality {
  if (accuracyM <= 25) return "good";
  if (accuracyM <= 75) return "fair";
  return "poor";
}

/** Ray casting on one ring. Points on an edge count as inside, matching ST_Covers on the server. */
function inRing(point: Position, ring: LinearRing): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (onSegment(point, a, b)) return true;
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function onSegment(p: Position, a: Position, b: Position): boolean {
  const cross = (p[1] - a[1]) * (b[0] - a[0]) - (p[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(cross) > 1e-12) return false;
  return (
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function inPolygon(point: Position, rings: readonly LinearRing[]): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !inRing(point, outer)) return false;
  return !holes.some((hole) => inRing(point, hole) && !onBoundary(point, hole));
}

function onBoundary(point: Position, ring: LinearRing): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a && b && onSegment(point, a, b)) return true;
  }
  return false;
}

export function shapeContains(shape: GeoShape, point: Position): boolean {
  if (shape.type === "Polygon") return inPolygon(point, shape.coordinates);
  return shape.coordinates.some((polygon) => inPolygon(point, polygon));
}

/** Great-circle distance in meters. */
export function haversineM(a: Position, b: Position): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance from a point to the nearest vertex or edge of a shape, in meters (planar near the point). */
export function distanceToShapeM(shape: GeoShape, point: Position): number {
  const polygons = shape.type === "Polygon" ? [shape.coordinates] : shape.coordinates;
  let best = Number.POSITIVE_INFINITY;
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((point[1] * Math.PI) / 180);
  const project = (p: Position): [number, number] => [
    (p[0] - point[0]) * metersPerDegLon,
    (p[1] - point[1]) * metersPerDegLat,
  ];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const a = ring[i];
        const b = ring[i + 1];
        if (!a || !b) continue;
        best = Math.min(best, segmentDistance(project(a), project(b)));
      }
    }
  }
  return best;
}

/** Distance from the origin to a segment. */
function segmentDistance(a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / lengthSq));
  return Math.hypot(a[0] + t * dx, a[1] + t * dy);
}

export function evaluateGeofence(
  fix: LocationFix | null,
  geofences: readonly Geofence[],
  nowMs: number,
): GeofenceStatus {
  if (geofences.length === 0) return { kind: "unfenced" };
  if (!fix) return { kind: "unknown", reason: "no-fix" };
  if (nowMs - fix.at > FIX_MAX_AGE_MS) return { kind: "unknown", reason: "stale" };
  if (fix.accuracyM > FIX_MAX_ACCURACY_M) return { kind: "unknown", reason: "coarse" };
  const quality = fixQuality(fix.accuracyM);
  const point: Position = [fix.longitude, fix.latitude];
  const inside = geofences.find((g) => shapeContains(g.boundary, point));
  if (inside) return { kind: "inside", geofence: inside, quality };
  let nearest: Geofence | null = null;
  let distanceM: number | null = null;
  for (const g of geofences) {
    const d = distanceToShapeM(g.boundary, point);
    if (distanceM === null || d < distanceM) {
      distanceM = d;
      nearest = g;
    }
  }
  return { kind: "outside", nearest, distanceM, quality };
}

export interface BatteryState {
  /** 0 to 1. */
  readonly level: number;
  readonly charging: boolean;
  readonly lowPowerMode: boolean;
}

export interface SamplingPlan {
  readonly accuracy: "high" | "balanced" | "low" | "off";
  readonly intervalMs: number;
  readonly distanceM: number;
}

/**
 * The battery budget (Section 4.3: battery-aware location sampling; Section 13: location sampling follows a
 * battery budget). Location is sampled only around clock events and while on shift, never in the
 * background when the person is off shift, and less often as the battery drains.
 */
export function samplingPlan(input: {
  readonly battery: BatteryState;
  readonly onShift: boolean;
  /** Minutes until the next call time; null when none today. */
  readonly minutesToCall: number | null;
  /** The person opened the clock or is about to punch. */
  readonly punching: boolean;
  readonly batterySaver: boolean;
}): SamplingPlan {
  const { battery, onShift, minutesToCall, punching, batterySaver } = input;
  if (punching) return { accuracy: "high", intervalMs: 5_000, distanceM: 0 };
  const nearCall = minutesToCall !== null && minutesToCall <= 30 && minutesToCall >= -15;
  if (!onShift && !nearCall) return { accuracy: "off", intervalMs: 0, distanceM: 0 };
  const saving = batterySaver || battery.lowPowerMode || (!battery.charging && battery.level < 0.2);
  if (saving) return { accuracy: "low", intervalMs: 15 * 60_000, distanceM: 250 };
  if (nearCall) return { accuracy: "balanced", intervalMs: 60_000, distanceM: 25 };
  return { accuracy: "balanced", intervalMs: 5 * 60_000, distanceM: 100 };
}
