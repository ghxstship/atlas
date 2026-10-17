import type { ReactElement } from "react";
import type { IconProps as ReferenceIconProps } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { iconSpriteUrl, iconSymbol, isMirrored } from "../lib/icons.ts";

export type IconProps = ReferenceIconProps;

/**
 * Draws a registered lucide icon at 1.5 stroke, sized from the icon tokens (16 by default), from the
 * cached icon sprite (`<use href>`, ADR 0027), so no icon geometry ships in page JavaScript.
 * Decorative unless `label` says the icon carries meaning alone; a labelled icon is an image named
 * by its title.
 */
export function Icon({
  name,
  size = 16,
  label,
  color,
  className,
  strokeWidth = 1.5,
}: IconProps): ReactElement {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...a11y}
      className={cx(
        "inline-block flex-none align-middle",
        isMirrored(name) && "xos-flip-rtl",
        className,
      )}
      style={color === undefined ? undefined : { color }}
    >
      {label ? <title>{label}</title> : null}
      <use href={`${iconSpriteUrl}#${iconSymbol(name)}`} />
    </svg>
  );
}
