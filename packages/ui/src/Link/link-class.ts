import { cx } from "../lib/cx.ts";

/**
 * Link classes without the component: no hooks and no context, so a server component can draw a
 * link the way Link does (ADR 0027).
 */
export const linkClass = cx(
  "xos-hit inline-flex items-center gap-2 font-medium text-accent-text no-underline",
  "hover:underline hover:underline-offset-(length:--space-2)",
);
