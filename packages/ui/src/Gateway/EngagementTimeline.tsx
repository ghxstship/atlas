import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { type EngagementTimelineProps } from "./Gateway.types.ts";

/** The engagement stages and where this engagement is. */
export function EngagementTimeline({ current, stages }: EngagementTimelineProps): ReactElement {
  const t = useT();
  return (
    <ol aria-label={t("engagement.stages")} className="flex flex-col m-0 p-0 list-none">
      {stages.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li
            key={s.label}
            aria-current={state === "current" ? "step" : undefined}
            className={cx(
              "relative flex items-start gap-12 py-6 text-text-secondary",
              state === "current" && "text-text-primary font-medium",
            )}
          >
            <span
              className={cx(
                "inline-grid place-items-center flex-none size-icon-20 rounded-full text-text-11 font-semibold tabular-nums",
                state === "todo" &&
                  "ring-(length:--stroke-width-hairline) ring-inset ring-border-strong",
                state === "current" && "bg-accent text-accent-text-on",
                state === "done" && "bg-bg-hover text-success",
              )}
            >
              {state === "done" ? <Icon name="Check" size={12} /> : i + 1}
            </span>
            <div className="flex flex-col">
              <strong className="font-semibold">{s.label}</strong>
              <span className="text-text-secondary">{s.date ?? s.owner}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
