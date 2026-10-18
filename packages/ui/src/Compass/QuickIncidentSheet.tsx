import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Phone, SheetFrame } from "./Compass.shared.tsx";
import { type QuickIncidentSheetProps } from "./Compass.types.ts";

/** Step one of the three-step incident report: choose the type from a grid. */
export function QuickIncidentSheet({
  frame,
  location,
  types,
  onSelect,
}: QuickIncidentSheetProps): ReactElement {
  const t = useT();
  return (
    <Phone frame={frame}>
      <SheetFrame title={t("incident.title")} step={t("count.step", { n: 1, total: 3 })}>
        <div className="grid grid-cols-3 gap-8">
          {types.map((type) => (
            <button
              key={type.label}
              type="button"
              onClick={() => onSelect?.(type.label)}
              className={cx(
                "flex flex-col items-center justify-center gap-8 min-h-(--ui-compass-thumb) p-8",
                "border rounded-card bg-bg-surface text-text-primary text-text-14 font-medium cursor-pointer",
                "active:bg-bg-hover forced-colors:border-[CanvasText]",
                "focus-visible:outline-stroke-focus focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
                type.critical ? "border-danger" : "border-border-control",
              )}
            >
              <Icon name={type.icon} size={28} className={type.critical ? "text-danger" : ""} />
              <span>{type.label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-6 text-text-secondary">
          <Icon name="MapPin" size={16} />
          {location}
        </div>
        <p className="m-0 text-text-12 text-text-secondary">{t("incident.help")}</p>
      </SheetFrame>
    </Phone>
  );
}
