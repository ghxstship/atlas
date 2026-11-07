import type { ButtonProps } from "../types/reference";
import { cx } from "../lib/cx.ts";

/**
 * Button classes without the component: no hooks and no context, so server components and the
 * hook-free templates in `@xos/ui/static` can style a link as a Button (ADR 0027).
 */

type Variant = NonNullable<ButtonProps["variant"]>;
type Size = NonNullable<ButtonProps["size"]>;

const base = cx(
  "inline-flex items-center justify-center gap-6 rounded-control border font-sans font-medium leading-none",
  "whitespace-nowrap cursor-pointer select-none transition-colors duration-fast ease-standard",
  "disabled:opacity-disabled disabled:cursor-not-allowed",
  "aria-disabled:opacity-disabled aria-disabled:cursor-not-allowed",
  "pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse",
  "forced-colors:border-[CanvasText] print:hidden",
);

/*
 * State fills never use a brightness filter: it moves the label with the fill, and took the primary
 * label to 4.06:1 hovered in Dark and the danger label under 4.5:1 pressed (A24-004). Primary
 * darkens with the scrim overlay (xos-fill-accent in styles/components.css); the others hold the
 * hover fill while pressed, a pair the contrast gate checks.
 */
const VARIANT: Record<Variant, string> = {
  primary: cx("xos-fill-accent bg-accent border-accent text-accent-text-on"),
  secondary: cx(
    "bg-bg-raised border-border-control text-text-primary hover:bg-bg-hover active:bg-bg-hover",
  ),
  ghost: cx(
    "bg-transparent border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary active:bg-bg-hover active:text-text-primary",
  ),
  danger: cx(
    "bg-transparent border-border-control text-danger-text hover:bg-bg-hover active:bg-bg-hover",
  ),
};

const SIZE: Record<Size, string> = {
  sm: cx("h-control-sm px-8 text-text-12"),
  md: cx("h-control-md px-12 text-text-13"),
  lg: cx("h-control-lg px-16 text-text-13"),
};

/** Shared button classes, for controls that look like a Button but are not one (triggers, steppers). */
export function buttonClass(variant: Variant = "secondary", size: Size = "md"): string {
  return cx(base, VARIANT[variant], SIZE[size]);
}

export const iconButtonClass = (variant: "ghost" | "secondary" = "ghost") =>
  cx(base, VARIANT[variant], "h-control-md min-w-control-md p-0");
