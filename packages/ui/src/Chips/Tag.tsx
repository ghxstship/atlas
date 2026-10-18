import type { ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { type TagProps } from "./Chips.types.ts";

const TAG_DOT: Record<NonNullable<TagProps["tone"]>, string> = {
  neutral: cx("bg-text-tertiary"),
  accent: cx("bg-accent"),
  success: cx("bg-success"),
  warning: cx("bg-warning"),
  danger: cx("bg-danger"),
};

/** A status word with a colored dot; the word carries the meaning. */
export function Tag({ tone = "neutral", children }: TagProps): ReactElement {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-4 h-(--ui-tag) px-6 rounded-chip bg-bg-hover text-text-secondary",
        "text-text-12 font-medium whitespace-nowrap forced-colors:border",
      )}
    >
      <span
        aria-hidden="true"
        className={cx("size-(--ui-dot) rounded-full flex-none", TAG_DOT[tone])}
      />
      {children}
    </span>
  );
}
