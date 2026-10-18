import type { ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { type BadgeProps } from "./Chips.types.ts";

const BADGE_TONE: Record<NonNullable<BadgeProps["tone"]>, string> = {
  neutral: cx("bg-bg-hover text-text-secondary"),
  accent: cx("bg-accent text-accent-text-on"),
  danger: cx("bg-danger text-danger-text-on"),
};

/** A count pill; above 99 it reads 99+. `label` names the count for assistive technology. */
export function Badge({ count, tone = "neutral", label, className }: BadgeProps): ReactElement {
  const text = count > 99 ? "99+" : String(count);
  return (
    <span
      className={cx(
        "inline-grid place-items-center min-w-(--ui-kbd) h-(--ui-kbd) px-6 rounded-pill",
        "text-text-11 font-semibold tabular-nums",
        BADGE_TONE[tone],
        className,
      )}
      {...(label ? { role: "img", "aria-label": label } : {})}
    >
      {text}
    </span>
  );
}
