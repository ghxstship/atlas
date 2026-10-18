import { type MapGeo } from "./Media.types.ts";

/** Converts a drawing point to longitude and latitude across the geo bounds. */
export function toLngLat(
  x: number,
  y: number,
  width: number,
  height: number,
  bounds: MapGeo["bounds"],
): [number, number] {
  const [west, south, east, north] = bounds;
  return [west + (x / width) * (east - west), north - (y / height) * (north - south)];
}
