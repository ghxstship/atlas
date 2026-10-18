import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { type StalenessIndicatorProps } from "./XOS.types.ts";

/** A price band's age: degraded one step at 12 months, Modeled at 24, Expired at 36. */
export function StalenessIndicator({ months, basis }: StalenessIndicatorProps): ReactElement {
  const t = useT();
  const [key, tone] =
    months >= 36
      ? ["stale.expired", cx("text-danger")]
      : months >= 24
        ? ["stale.modeled", cx("text-warning")]
        : months >= 12
          ? ["stale.degraded", cx("text-warning")]
          : ["stale.current", cx("text-success")];
  return (
    <span
      className={chipClass}
      title={t("stale.title", { n: months, basis: basis ?? t("stale.basis") })}
    >
      <span className={tone}>
        <Icon name="Clock" size={14} />
      </span>
      <span>{t(key)}</span>
      <span className="text-text-secondary tabular-nums">{t("stale.months", { n: months })}</span>
    </span>
  );
}
