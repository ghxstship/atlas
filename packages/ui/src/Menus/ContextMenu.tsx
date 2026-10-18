import type { ReactElement } from "react";
import { ContextMenu as RContextMenu } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { ItemBody, dangerClass, headClass, renderItems, sepClass } from "./Menus.shared.tsx";
import { type ContextMenuProps } from "./Menus.types.ts";
import { menuClass } from "./menuClass.tsx";
import { menuItemClass } from "./menuItemClass.tsx";

/** The record menu's actions on right-click or Shift+F10 over `children`. */
export function ContextMenu({ label, items, children }: ContextMenuProps): ReactElement {
  const t = useT();
  const name = label ?? t("menu.actions");
  if (children === undefined) {
    return (
      <div role="menu" aria-label={name} className={menuClass}>
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} role="separator" className={sepClass} />
          ) : item.heading ? (
            <div key={i} role="presentation" className={headClass}>
              {item.heading}
            </div>
          ) : (
            <div
              key={i}
              role="menuitem"
              tabIndex={-1}
              onClick={item.onSelect}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") item.onSelect?.();
              }}
              className={cx(
                menuItemClass,
                "hover:bg-bg-hover",
                item.danger && dangerClass,
                item.active && "bg-bg-hover",
              )}
            >
              <ItemBody item={item} />
            </div>
          ),
        )}
      </div>
    );
  }
  return (
    <RContextMenu.Root modal={false}>
      <RContextMenu.Trigger asChild>{children}</RContextMenu.Trigger>
      <RContextMenu.Portal>
        <RContextMenu.Content className={menuClass} aria-label={name} collisionPadding={16}>
          {renderItems(RContextMenu, items)}
        </RContextMenu.Content>
      </RContextMenu.Portal>
    </RContextMenu.Root>
  );
}
