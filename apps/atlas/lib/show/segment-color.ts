import { segmentKey } from "@xos/data/show";

/**
 * The color the cue editor shows for the segment typed (B3, ADR 0142). It follows the text: what the person picked,
 * else the color the running order already gives that segment, else none. A picked "" is a choice to clear it.
 */
export function shownSegmentColor(
  picked: string | null,
  segment: string,
  colors: Readonly<Record<string, string>>,
): string {
  return picked ?? colors[segmentKey(segment)] ?? "";
}

/**
 * The color to write for a save, or undefined to write none: only one the person picked, only when it differs from
 * what the segment has, and never for a cue with no segment. So renaming a cue into a colored segment leaves its color.
 */
export function segmentColorToWrite(
  picked: string | null,
  segment: string,
  colors: Readonly<Record<string, string>>,
): string | null | undefined {
  if (picked === null || segment.trim() === "") return undefined;
  if (picked === (colors[segmentKey(segment)] ?? "")) return undefined;
  return picked === "" ? null : picked;
}
