import { createContext } from "react";
import { cx } from "../lib/cx.ts";
import { type Tone } from "./Feedback.types.ts";

export const TONE_ICON: Record<Tone, string> = {
  info: "Info",
  success: "CircleCheck",
  warning: "TriangleAlert",
  danger: "OctagonAlert",
};

export const TONE_ICON_CLASS: Record<Tone, string> = {
  info: cx("text-state-scheduled"),
  success: cx("text-success"),
  warning: cx("text-warning"),
  danger: cx("text-danger"),
};

export const alertClass = cx(
  "flex gap-8 p-12 max-w-(--ui-alert) rounded-card border border-border-subtle bg-bg-surface",
  "forced-colors:border-[CanvasText]",
);

export const stateClass = cx(
  "flex flex-col items-center gap-12 p-40 max-w-(--ui-empty) text-center rounded-card",
  "border border-dashed border-border-strong",
);

/*
 * Inside a ToastRegion the region is the live region, mounted before any toast arrives, so a toast
 * added later is announced (4.1.3, A23-014). A toast outside one keeps its own status role.
 */
export const InToastRegion = createContext(false);

export const toastClass = cx(
  "xos-anim-fade relative inline-flex items-center gap-12 overflow-hidden py-8 ps-12 pe-8",
  "rounded-card bg-bg-raised shadow-menu print:hidden forced-colors:border",
);
