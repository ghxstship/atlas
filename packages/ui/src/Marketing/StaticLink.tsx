import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { linkClass } from "../Link/link-class.ts";
import { marketingCopy } from "./marketing-copy.ts";
import { type StaticLinkProps } from "./Marketing.types.ts";

/**
 * Link for a server component: the same anchor as the product Link. An external link opens in a
 * new tab and says so in the page's `locale`, from `messages`.
 */
export function StaticLink({
  external = false,
  className,
  children,
  locale,
  messages,
  ...rest
}: StaticLinkProps): ReactElement {
  return (
    <a
      {...rest}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cx(linkClass, className)}
    >
      {children}
      {external ? (
        <Icon
          name="ExternalLink"
          size={12}
          label={marketingCopy({ locale, messages }).t("link.newTab")}
        />
      ) : null}
    </a>
  );
}
