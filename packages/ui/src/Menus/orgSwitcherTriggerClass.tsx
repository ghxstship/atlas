import { cx } from "../lib/cx.ts";

/** The OrgSwitcher trigger's classes, for a host that renders the closed trigger before the menu loads. */
export const orgSwitcherTriggerClass = cx(
  "flex items-center justify-between gap-8 w-(--ui-orgsw) max-w-full h-row-default px-8 rounded-control",
  "bg-transparent text-text-primary cursor-pointer hover:bg-bg-hover pointer-coarse:min-h-target-coarse",
);
