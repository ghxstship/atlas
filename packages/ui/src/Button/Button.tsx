import type { ReactElement } from "react";
import type {
  ButtonProps as ReferenceButtonProps,
  IconButtonProps as ReferenceIconButtonProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Keys } from "../Kbd/Kbd.tsx";

export type ButtonProps = ReferenceButtonProps;
export type IconButtonProps = ReferenceIconButtonProps;
type Variant = NonNullable<ButtonProps["variant"]>;
type Size = NonNullable<ButtonProps["size"]>;

const base = cx(
  "inline-flex items-center justify-center gap-6 rounded-control border font-sans font-medium leading-none",
  "whitespace-nowrap cursor-pointer select-none transition-colors duration-fast ease-standard",
  "active:brightness-90 disabled:opacity-disabled disabled:cursor-not-allowed",
  "aria-disabled:opacity-disabled aria-disabled:cursor-not-allowed",
  "pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse",
  "forced-colors:border-[CanvasText] print:hidden",
);

const VARIANT: Record<Variant, string> = {
  primary: cx("bg-accent border-accent text-accent-text-on hover:brightness-110"),
  secondary: cx("bg-bg-raised border-border-control text-text-primary hover:bg-bg-hover"),
  ghost: cx(
    "bg-transparent border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary",
  ),
  danger: cx("bg-transparent border-border-control text-danger-text hover:bg-bg-hover"),
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

function Spinner(): ReactElement {
  return (
    <svg
      className="xos-anim-spin inline-block flex-none"
      width={14}
      height={14}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle
        cx={8}
        cy={8}
        r={6}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray="28 10"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Triggers one action. One primary per screen; `loading` sets aria-busy and blocks repeat clicks
 * without disabling focus.
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  shortcut,
  className,
  children,
  type = "button",
  onClick,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      {...rest}
      {...(loading ? { "aria-busy": true, "aria-disabled": true } : {})}
      onClick={loading ? undefined : onClick}
      className={cx(buttonClass(variant, size), className)}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={14} /> : null}
      {children}
      {shortcut ? (
        <span className="ms-4 inline-flex">
          <Keys keys={shortcut} />
        </span>
      ) : null}
    </button>
  );
}

/**
 * A square control with one icon and a required label, used as aria-label and the tooltip text.
 */
export function IconButton({
  icon,
  label,
  shortcut,
  variant = "ghost",
  className,
  type = "button",
  ...rest
}: IconButtonProps): ReactElement {
  const t = useT();
  return (
    <button
      type={type}
      aria-label={label}
      title={shortcut ? t("tooltip.withShortcut", { label, shortcut }) : label}
      {...rest}
      className={cx(iconButtonClass(variant), className)}
    >
      <Icon name={icon} />
    </button>
  );
}
