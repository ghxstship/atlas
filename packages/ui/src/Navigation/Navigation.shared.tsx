import { type ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { type NavItem } from "./Navigation.types.ts";

/** A destination: a link when it has an href, otherwise a button that runs the item's action. */
export function ItemAction({
  item,
  active,
  className,
  children,
}: {
  item: NavItem;
  active: boolean;
  className: string;
  children: ReactNode;
}) {
  const current = active ? ("page" as const) : undefined;
  return item.href ? (
    <a href={item.href} aria-current={current} onClick={item.onSelect} className={className}>
      {children}
    </a>
  ) : (
    <button
      type="button"
      aria-current={current}
      onClick={item.onSelect}
      className={cx(className, "bg-transparent border-0 cursor-pointer")}
    >
      {children}
    </button>
  );
}
