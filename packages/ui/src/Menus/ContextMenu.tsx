import type { ReactElement } from "react";
import { ContextMenu as RContextMenu, DropdownMenu as RDropdownMenu } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { ItemBody, dangerClass, headClass, renderItems, sepClass } from "./Menus.shared.tsx";
import { type ContextMenuProps } from "./Menus.types.ts";
import { menuClass } from "./menuClass.tsx";
import { menuItemClass } from "./menuItemClass.tsx";

/**
 * The record menu's actions on right-click or Shift+F10 over `children`, or at a point the page
 * gives (`at`). The point menu is Radix's dropdown anchored to an empty mark at the point: arrow
 * keys, typeahead and Esc work as in every menu, and focus returns to `returnFocus` on close.
 */
export function ContextMenu({
  label,
  items,
  children,
  at,
  onClose,
  returnFocus,
}: ContextMenuProps): ReactElement {
  const t = useT();
  const name = label ?? t("menu.actions");
  if (at) {
    return (
      <RDropdownMenu.Root
        open
        modal={false}
        onOpenChange={(open) => {
          if (!open) onClose?.();
        }}
      >
        <RDropdownMenu.Trigger asChild>
          <span
            aria-hidden="true"
            className="pointer-events-none fixed size-0"
            // design-audit-allow: the pointer's viewport position, data rather than design
            style={{ left: at.x, top: at.y }}
          />
        </RDropdownMenu.Trigger>
        <RDropdownMenu.Portal>
          <RDropdownMenu.Content
            className={menuClass}
            aria-label={name}
            // The anchor mark is empty, so the menu takes its name from the label instead.
            aria-labelledby={undefined}
            align="start"
            collisionPadding={16}
            onCloseAutoFocus={(event) => {
              if (returnFocus?.isConnected) {
                event.preventDefault();
                returnFocus.focus();
              }
            }}
          >
            {renderItems(RDropdownMenu, items)}
          </RDropdownMenu.Content>
        </RDropdownMenu.Portal>
      </RDropdownMenu.Root>
    );
  }
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
