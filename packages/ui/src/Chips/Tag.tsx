import type { ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { type TagProps, type TagSwatch } from "./Chips.types.ts";

const TAG_DOT: Record<NonNullable<TagProps["tone"]>, string> = {
  neutral: cx("bg-text-tertiary"),
  accent: cx("bg-accent"),
  success: cx("bg-success"),
  warning: cx("bg-warning"),
  danger: cx("bg-danger"),
};

const TAG_SWATCH: Record<TagSwatch, string> = {
  "cat-1": cx("bg-viz-cat-1"),
  "cat-2": cx("bg-viz-cat-2"),
  "cat-3": cx("bg-viz-cat-3"),
  "cat-4": cx("bg-viz-cat-4"),
  "cat-5": cx("bg-viz-cat-5"),
  "cat-6": cx("bg-viz-cat-6"),
  "cat-7": cx("bg-viz-cat-7"),
};

/**
 * A status word with a colored dot; the word carries the meaning. A swatch colours the dot with a themed
 * categorical token (light, dark and sunlight) for a user-defined choice; in forced colors the dot takes the text
 * colour and the tag keeps its border.
 */
export function Tag({ tone = "neutral", swatch, children }: TagProps): ReactElement {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-4 h-(--ui-tag) px-6 rounded-chip bg-bg-hover text-text-secondary",
        "text-text-12 font-medium whitespace-nowrap forced-colors:border",
      )}
    >
      <span
        aria-hidden="true"
        data-swatch={swatch}
        className={cx(
          "size-(--ui-dot) rounded-full flex-none",
          swatch ? cx(TAG_SWATCH[swatch], "forced-colors:bg-[CanvasText]") : TAG_DOT[tone],
        )}
      />
      {children}
    </span>
  );
}
