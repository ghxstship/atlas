import { type ReactElement } from "react";
import { type ProgressBarProps } from "./Gateway.types.ts";

/** Determinate progress with its percentage. */
export function ProgressBar({ label, value }: ProgressBarProps): ReactElement {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="flex flex-col gap-6 w-(--ui-field) max-w-full">
      <div className="flex justify-between text-text-12 text-text-secondary">
        <span>{label}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-(--space-4) rounded-pill bg-bg-hover overflow-hidden"
      >
        <div
          className="h-full rounded-pill bg-accent forced-colors:bg-[Highlight]"
          style={{ inlineSize: `${pct}%` }}
        />
      </div>
    </div>
  );
}
