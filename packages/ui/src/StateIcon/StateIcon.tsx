import type { ReactElement, ReactNode } from "react";
import type { RecordState, StateIconProps as ReferenceStateIconProps } from "../types/reference";
import { cx } from "../lib/cx.ts";

export type StateIconProps = ReferenceStateIconProps;

/** State hue classes. The shape carries meaning; the hue reinforces it. */
const STATE_CLASS: Record<RecordState, string> = {
  proposed: cx("text-state-proposed"),
  ready: cx("text-state-ready"),
  scheduled: cx("text-state-scheduled"),
  active: cx("text-state-active"),
  blocked: cx("text-state-blocked"),
  "in-review": cx("text-state-in-review"),
  complete: cx("text-state-complete"),
  deferred: cx("text-state-deferred"),
  canceled: cx("text-state-canceled"),
};

const CUT = "var(--color-bg-canvas)";

function ring(extra: Record<string, string> = {}): ReactNode {
  return (
    <circle cx={8} cy={8} r={6} fill="none" stroke="currentColor" strokeWidth={1.5} {...extra} />
  );
}

function shape(state: RecordState): ReactNode {
  switch (state) {
    case "proposed":
      return ring({ strokeDasharray: "2.2 2.2" });
    case "scheduled":
      return (
        <>
          {ring()}
          <path
            d="M8 5v3.25l2 1.25"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </>
      );
    case "active":
      return (
        <>
          {ring()}
          <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
        </>
      );
    case "blocked":
      return (
        <>
          <path d="M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5z" fill="currentColor" />
          <path d="M5.5 8h5" stroke={CUT} strokeWidth={1.5} strokeLinecap="round" />
        </>
      );
    case "in-review":
      return (
        <>
          {ring()}
          <path
            d="M4.75 8s1.25-2 3.25-2s3.25 2 3.25 2s-1.25 2-3.25 2s-3.25-2-3.25-2z"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
          />
          <circle cx={8} cy={8} r={0.9} fill="currentColor" />
        </>
      );
    case "complete":
      return (
        <>
          <circle cx={8} cy={8} r={6.75} fill="currentColor" />
          <path
            d="M5.25 8.25l1.75 1.75l3.5-4"
            fill="none"
            stroke={CUT}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "deferred":
      return (
        <>
          {ring()}
          <path
            d="M6.75 5.75v4.5M9.25 5.75v4.5"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </>
      );
    case "canceled":
      return (
        <>
          {ring()}
          <path d="M4 12l8-8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        </>
      );
    default:
      return ring();
  }
}

/** One of the nine record state icons, drawn by this system (filled and half-filled shapes). Decorative: pair it with a label. */
export function StateIcon({ state, size = 14 }: StateIconProps): ReactElement {
  return (
    <svg
      className={cx(
        "inline-block flex-none align-middle",
        STATE_CLASS[state] ?? "text-text-secondary",
      )}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-state={state}
    >
      {shape(state)}
    </svg>
  );
}
