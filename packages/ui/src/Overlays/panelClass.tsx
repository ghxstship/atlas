import { cx } from "../lib/cx.ts";

export const panelClass = cx(
  "bg-bg-raised text-text-primary shadow-dialog rounded-dialog box-border max-w-full",
  "forced-colors:border-[CanvasText] forced-colors:border print:shadow-none",
);
