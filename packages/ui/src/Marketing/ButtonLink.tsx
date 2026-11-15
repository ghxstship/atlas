import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { buttonClass } from "../Button/button-class.ts";
import { Icon } from "../Icon/Icon.tsx";
import { type ButtonLinkProps } from "./Marketing.types.ts";

/**
 * A link drawn as a Button, for calls to action that navigate. Button stays for actions that happen
 * in place; `xl` is the 44 px call to action size on public pages.
 */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  trailingIcon,
  external = false,
  className,
  children,
  ...rest
}: ButtonLinkProps): ReactElement {
  return (
    <a
      {...rest}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cx(buttonClass(variant, size), "box-border no-underline", className)}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
      {trailingIcon ? <Icon name={trailingIcon} size={14} /> : null}
    </a>
  );
}
