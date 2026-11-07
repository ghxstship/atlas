import type { ReactElement } from "react";
import type {
  ButtonProps as ReferenceButtonProps,
  IconButtonProps as ReferenceIconButtonProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { buttonClass, iconButtonClass } from "./button-class.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Keys } from "../Kbd/Kbd.tsx";

export type ButtonProps = ReferenceButtonProps;
export type IconButtonProps = ReferenceIconButtonProps;

export { buttonClass, iconButtonClass };

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
      {/* A touch screen has no keyboard to press it with, so the hint stays off there (A59-023). */}
      {shortcut ? (
        <span className="ms-4 inline-flex pointer-coarse:hidden">
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
