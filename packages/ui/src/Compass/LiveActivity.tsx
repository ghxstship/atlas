import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { blockClass, compassText } from "./Compass.shared.tsx";
import { type LiveActivityProps } from "./Compass.types.ts";

/** The lock screen Live Activity and the home screen widget layouts. */
export function LiveActivity({
  label,
  elapsed,
  place,
  nextShift,
  nextTime,
  onBreak = false,
  onToggleBreak,
  onClockOut,
}: LiveActivityProps): ReactElement {
  const t = useT();
  return (
    <div className={cx("xos-compass flex flex-col gap-12", compassText)}>
      <div
        role="group"
        aria-label={t("live.label")}
        className="flex flex-col gap-8 w-(--ui-compass-card) max-w-full box-border p-16 rounded-widget bg-bg-raised shadow-menu"
      >
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-6">
            <Icon
              name={onBreak ? "Coffee" : "Clock"}
              size={16}
              className={onBreak ? "text-warning" : "text-success"}
            />
            <strong>{label}</strong>
          </span>
          <span className="text-heading-24 font-semibold tabular-nums">{elapsed}</span>
        </div>
        <span className="text-text-secondary">{place}</span>
        <div className="flex gap-8">
          <Button size="lg" className={blockClass} onClick={onToggleBreak}>
            {t(onBreak ? "clock.endBreak" : "clock.break")}
          </Button>
          <Button size="lg" variant="primary" className={blockClass} onClick={onClockOut}>
            {t("clock.out")}
          </Button>
        </div>
      </div>
      <div
        role="group"
        aria-label={t("widget.label")}
        className="flex flex-col justify-end gap-2 size-(--ui-widget) box-border p-16 rounded-widget bg-bg-raised shadow-menu"
      >
        <span className="text-text-secondary">{t("widget.nextShift")}</span>
        <strong>{nextShift}</strong>
        <span className="tabular-nums">{nextTime}</span>
      </div>
    </div>
  );
}
