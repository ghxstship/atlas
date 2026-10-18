import { cx } from "../lib/cx.ts";

/** The chip shape shared by every chip and property: 22 px, hairline border, surface ground. */
export const chipClass = cx(
  "inline-flex items-center gap-4 h-(--ui-chip) px-6 rounded-chip border border-border-subtle",
  "bg-bg-surface text-text-primary font-sans text-text-12 whitespace-nowrap",
  "transition-colors duration-fast ease-standard forced-colors:border-[CanvasText]",
);
