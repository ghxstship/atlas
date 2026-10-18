import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Card } from "../Surface/Surface.tsx";
import { type OnboardingChecklistProps } from "./Help.types.ts";

/** First-run steps with progress; done steps are struck through. */
export function OnboardingChecklist({
  title,
  steps,
  onAction,
}: OnboardingChecklistProps): ReactElement {
  const t = useT();
  const done = steps.filter((s) => s.done).length;
  return (
    <Card title={title} meta={t("count.of", { n: done, total: steps.length })}>
      <div
        role="progressbar"
        aria-label={title}
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        className="h-(--space-4) rounded-pill bg-bg-hover overflow-hidden"
      >
        <div
          className="h-full rounded-pill bg-accent"
          style={{ inlineSize: `${steps.length ? (done / steps.length) * 100 : 0}%` }}
        />
      </div>
      <ol className="flex flex-col m-0 p-0 list-none">
        {steps.map((s) => (
          <li
            key={s.label}
            className="flex items-center gap-8 min-h-(--space-40) border-b border-border-subtle last:border-b-0"
          >
            <span className={s.done ? "text-success" : "text-text-tertiary"}>
              <Icon
                name={s.done ? "CircleCheck" : "Circle"}
                {...(s.done ? { label: t("action.done") } : {})}
              />
            </span>
            <span className={cx("flex-1", s.done && "text-text-secondary line-through")}>
              {s.label}
            </span>
            {!s.done && s.action ? (
              <Button size="sm" onClick={() => onAction?.(s.label)}>
                {s.action}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
