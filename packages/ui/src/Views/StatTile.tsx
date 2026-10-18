import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Money } from "../Forms/Forms.tsx";
import { Sparkline } from "../Charts/Sparkline.tsx";
import { type StatTileProps } from "./Views.types.ts";

/**
 * One headline number with its change and whether the change is good. Direction is an icon and a
 * signed number as well as color; a blank value reads No value, never 0.
 */
export function StatTile({
  label,
  value,
  format = "number",
  delta,
  deltaUnit,
  deltaLabel,
  goodWhen,
  caption,
  onDrill,
  trend,
}: StatTileProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const direction =
    delta === undefined || delta === null ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const good =
    goodWhen !== undefined &&
    direction !== null &&
    direction !== "flat" &&
    (goodWhen === "up") === (direction === "up");
  const bad = goodWhen !== undefined && direction !== null && direction !== "flat" && !good;
  const figure =
    format === "money" ? (
      <Money amount={value} />
    ) : value === null ? (
      <span className="text-text-secondary">{t("chart.noValue")}</span>
    ) : (
      fmt.number(value)
    );
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-4 min-w-(--ui-stat-min) p-16 rounded-card border border-border-subtle bg-bg-raised"
    >
      <span className="text-text-12 font-medium text-text-secondary">{label}</span>
      <strong className="text-heading-32 font-semibold tabular-nums">
        {onDrill ? (
          <button
            type="button"
            onClick={onDrill}
            className="p-0 border-0 bg-transparent cursor-pointer text-inherit hover:underline"
          >
            {figure}
          </button>
        ) : (
          figure
        )}
      </strong>
      {direction !== null && delta !== null && delta !== undefined ? (
        <span
          className={cx(
            "flex items-center gap-4 text-text-12 text-text-secondary",
            good && "text-success-text",
            bad && "text-danger-text",
          )}
        >
          <Icon
            name={direction === "up" ? "ArrowUp" : direction === "down" ? "ArrowDown" : "Minus"}
            size={14}
          />
          <span className="tabular-nums">
            {delta > 0 ? "+" : ""}
            {fmt.number(delta)}
            {deltaUnit ?? ""}
          </span>
          {deltaLabel ? <span className="text-text-secondary">{deltaLabel}</span> : null}
        </span>
      ) : null}
      {trend && trend.length > 1 ? (
        <Sparkline values={trend} label={t("stat.trend", { label })} />
      ) : null}
      {caption ? <span className="text-text-secondary">{caption}</span> : null}
    </section>
  );
}
