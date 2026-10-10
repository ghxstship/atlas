import type { ReactElement } from "react";
import type { BrandMarkProps as ReferenceBrandMarkProps } from "../types/reference";
import { cx } from "../lib/cx.ts";

export type BrandMarkProps = ReferenceBrandMarkProps;

const TILE: Record<NonNullable<BrandMarkProps["size"]>, string> = {
  sm: cx("size-icon-20 text-text-11 rounded-control"),
  md: cx("h-control-md min-w-control-md text-text-11 rounded-control"),
  lg: cx("h-(--space-40) min-w-(--space-40) text-heading-16 rounded-card"),
};

const NAME: Record<NonNullable<BrandMarkProps["size"]>, string> = {
  sm: cx("text-text-13"),
  md: cx("text-text-14"),
  lg: cx("text-heading-20"),
};

const LOGO: Record<NonNullable<BrandMarkProps["size"]>, string> = {
  sm: cx("h-(--icon-size-20)"),
  md: cx("h-control-md"),
  lg: cx("h-(--space-40)"),
};

export function monogram(name: string, override?: string): string {
  return (
    override ??
    name
      .replace(/[^A-Za-z0-9 ]/g, "")
      .split(/\s+/)
      .map((w) => w.charAt(0))
      .join("")
      .slice(0, 2)
  ).toUpperCase();
}

/**
 * The white-label mark (ADR 0011): the tenant's light or dark logo for the current theme, or a
 * monogram tile in accent-default with the name until logos are set.
 */
export function BrandMark({
  name,
  logoLight,
  logoDark,
  monogram: mark,
  size = "md",
  iconOnly = false,
}: BrandMarkProps): ReactElement {
  if (logoLight || logoDark) {
    return (
      <span className="inline-flex items-center gap-8">
        {logoDark ? (
          <img
            src={logoDark}
            alt={name}
            className={cx(
              LOGO[size],
              "w-auto in-data-[theme=light]:hidden in-data-[theme=sunlight]:hidden",
            )}
          />
        ) : null}
        {logoLight ? (
          <img
            src={logoLight}
            alt={logoDark ? "" : name}
            className={cx(
              LOGO[size],
              "w-auto",
              logoDark && "hidden in-data-[theme=light]:inline in-data-[theme=sunlight]:inline",
            )}
          />
        ) : null}
      </span>
    );
  }
  return (
    <span role="img" aria-label={name} className="inline-flex items-center gap-8">
      <span
        aria-hidden="true"
        className={cx(
          "inline-grid place-items-center bg-accent text-accent-text-on font-bold leading-none tracking-wide",
          "forced-colors:forced-color-adjust-none",
          TILE[size],
        )}
      >
        {monogram(name, mark)}
      </span>
      {iconOnly ? null : (
        <span aria-hidden="true" className={cx("font-semibold text-text-primary", NAME[size])}>
          {name}
        </span>
      )}
    </span>
  );
}
