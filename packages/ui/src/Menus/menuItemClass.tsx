import { cx } from "../lib/cx.ts";

export const menuItemClass = cx(
  "flex items-center gap-8 h-control-lg px-8 rounded-control text-text-primary cursor-pointer outline-none select-none",
  "data-highlighted:bg-bg-hover data-[state=open]:bg-bg-hover data-disabled:opacity-disabled data-disabled:cursor-not-allowed",
  "pointer-coarse:min-h-target-coarse [&_svg]:text-text-secondary",
);
