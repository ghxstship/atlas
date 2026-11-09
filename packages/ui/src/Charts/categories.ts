import { cx } from "../lib/cx.ts";
import type { TimelineCategory } from "./Charts.types.ts";

/**
 * Categorical colour steps of day-type tags and row segments (viz-cat-1 to viz-cat-7, B4). A small module of its
 * own so the Calendar, the Timeline and the day sheet share it without loading each other.
 */
export const TL_CATEGORY: Readonly<Record<number, string>> = {
  1: cx("bg-viz-cat-1"),
  2: cx("bg-viz-cat-2"),
  3: cx("bg-viz-cat-3"),
  4: cx("bg-viz-cat-4"),
  5: cx("bg-viz-cat-5"),
  6: cx("bg-viz-cat-6"),
  7: cx("bg-viz-cat-7"),
};

/** A day's or a segment's categories as text, for the table alternative and announcements. */
export function categoryText(tags: readonly TimelineCategory[] | undefined): string {
  return (tags ?? []).map((tag) => tag.label).join(", ");
}
