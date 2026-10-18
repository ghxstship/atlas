import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { type StepperProps } from "./Layout.types.ts";

/** Wizard progress: done steps show a check, the current step is marked for assistive technology. */
export function Stepper({ steps, current }: StepperProps): ReactElement {
  return (
    <ol className="flex flex-wrap items-center gap-8 m-0 p-0 list-none">
      {steps.map((step, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li
            key={step}
            aria-current={state === "current" ? "step" : undefined}
            className={cx(
              "flex items-center gap-6 text-text-secondary",
              "[&+&]:before:w-(--ui-step-line) [&+&]:before:h-(--stroke-width-hairline) [&+&]:before:bg-border-strong [&+&]:before:me-2",
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
            <span>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
