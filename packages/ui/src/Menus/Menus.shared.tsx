import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { type MenuItem, type Parts } from "./Menus.types.ts";
import { menuClass } from "./menuClass.tsx";
import { menuItemClass } from "./menuItemClass.tsx";

export const dangerClass = cx("text-danger-text [&_svg]:text-danger");

export const headClass = cx("px-8 pt-6 pb-2 text-text-11 font-medium text-text-secondary");

export const sepClass = cx("h-(--stroke-width-hairline) my-4 bg-border-subtle");

export function ItemBody({ item }: { item: MenuItem }) {
  return (
    <>
      {item.icon ? <Icon name={item.icon} /> : null}
      <span className="flex-1">{item.label}</span>
      {item.shortcut ? (
        <span className="ms-auto">
          <Keys keys={item.shortcut} />
        </span>
      ) : item.submenu || item.items ? (
        <Icon name="ChevronRight" size={14} className="ms-auto" />
      ) : null}
    </>
  );
}

export function renderItems(P: Parts, items: MenuItem[]): ReactNode {
  return items.map((item, i) => {
    const key = `${item.label ?? item.heading ?? "sep"}-${i}`;
    if (item.separator) return <P.Separator key={key} className={sepClass} />;
    if (item.heading) {
      return (
        <P.Label key={key} className={headClass}>
          {item.heading}
        </P.Label>
      );
    }
    if (item.items) {
      return (
        <P.Sub key={key}>
          <P.SubTrigger className={cx(menuItemClass, item.danger && dangerClass)}>
            <ItemBody item={item} />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent className={menuClass} sideOffset={4}>
              {renderItems(P, item.items)}
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      );
    }
    return (
      <P.Item
        key={key}
        className={cx(menuItemClass, item.danger && dangerClass, item.active && "bg-bg-hover")}
        {...(item.disabled ? { disabled: true } : {})}
        {...(item.onSelect ? { onSelect: item.onSelect } : {})}
      >
        <ItemBody item={item} />
      </P.Item>
    );
  });
}
