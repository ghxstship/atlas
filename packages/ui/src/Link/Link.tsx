import type { ReactElement } from "react";
import type { LinkProps as ReferenceLinkProps } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { linkClass } from "./link-class.ts";

export type LinkProps = ReferenceLinkProps;

export { linkClass };

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
