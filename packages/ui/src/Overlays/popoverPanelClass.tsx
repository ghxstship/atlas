import { cx } from "../lib/cx.ts";

export const popoverPanelClass = cx(
  "xos-anim-pop bg-bg-raised text-text-primary shadow-menu rounded-card box-border",
  "max-w-[calc(100vw-var(--space-32))] forced-colors:border",
);
