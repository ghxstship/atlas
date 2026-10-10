import type { ReactElement } from "react";
import type { IconProps as ReferenceIconProps } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { isMirrored, resolveIcon } from "../lib/icons.ts";

export type IconProps = ReferenceIconProps;

/**
 * Draws any lucide-react icon at 1.5 stroke, sized from the icon tokens (16 by default). Hidden from
 * assistive technology unless `label` says the icon carries meaning alone.
 */
export function Icon({
  name,
  size = 16,
  label,
  color,
  className,
  strokeWidth = 1.5,
}: IconProps): ReactElement {
  const Glyph = resolveIcon(name);
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  const classes = cx(
    "inline-block flex-none align-middle",
    isMirrored(name) && "xos-flip-rtl",
    className,
  );
  if (Glyph === null) {
    return <span {...a11y} className={classes} style={{ inlineSize: size, blockSize: size }} />;
  }
  return (
    <Glyph
      {...a11y}
      className={classes}
      size={size}
      strokeWidth={strokeWidth}
      style={color === undefined ? undefined : { color }}
    />
  );
}
