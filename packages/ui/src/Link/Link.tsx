import type { ReactElement } from "react";
import type { LinkProps as ReferenceLinkProps } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";

export type LinkProps = ReferenceLinkProps;

export const linkClass = cx(
  "xos-hit inline-flex items-center gap-2 font-medium text-accent-text no-underline",
  "hover:underline hover:underline-offset-(length:--space-2)",
);

/** Navigates; Button acts. External links open in a new tab and say so. */
export function Link({ external = false, className, children, ...rest }: LinkProps): ReactElement {
  const t = useT();
  return (
    <a
      {...rest}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cx(linkClass, className)}
    >
      {children}
      {external ? <Icon name="ExternalLink" size={12} label={t("link.newTab")} /> : null}
    </a>
  );
}
