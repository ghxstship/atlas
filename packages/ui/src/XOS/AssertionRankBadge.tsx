import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { type AssertionRankBadgeProps } from "./XOS.types.ts";

/** An assertion value with four pips for its rank from 4 down to 0. */
export function AssertionRankBadge({ label, rank }: AssertionRankBadgeProps): ReactElement {
  const t = useT();
  const on = rank === 4 ? "bg-success" : rank <= 1 ? "bg-warning" : "bg-text-secondary";
  return (
    <span role="img" aria-label={t("assertion.aria", { label, rank })} className={chipClass}>
      <span aria-hidden="true" className="inline-flex gap-2">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cx(
              "w-(--ui-pip-inline) h-(--ui-pip-block) rounded-mark",
              i <= rank ? on : "bg-border-strong",
            )}
          />
        ))}
      </span>
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
