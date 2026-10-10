import type { ReactElement, ReactNode } from "react";
import { ContextMenu as RContextMenu, DropdownMenu as RDropdownMenu } from "radix-ui";
import type {
  ContextMenuProps as ReferenceContextMenuProps,
  DropdownMenuProps as ReferenceDropdownMenuProps,
  MenuItem as ReferenceMenuItem,
  OrgSwitcherProps as ReferenceOrgSwitcherProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { buttonClass } from "../Button/Button.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { Badge } from "../Chips/Chips.tsx";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { popoverPanelClass } from "../Overlays/Overlays.tsx";

export interface MenuItem extends ReferenceMenuItem {
  onSelect?: () => void;
  disabled?: boolean;
  /** Items of a submenu; the item opens it with Arrow Right (Arrow Left in right-to-left). */
  items?: MenuItem[];
}

export type DropdownMenuProps = Omit<ReferenceDropdownMenuProps, "items"> & {
  items: MenuItem[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};
export type ContextMenuProps = Omit<ReferenceContextMenuProps, "items"> & {
  items: MenuItem[];
  /** The region that opens the menu on right-click, long press or Shift+F10. Without it the menu renders on its own. */
  children?: ReactNode;
};
export type OrgSwitcherProps = ReferenceOrgSwitcherProps & {
  onSelect?: (name: string) => void;
  onMarketplace?: () => void;
  defaultOpen?: boolean;
};

export const menuClass = cx(popoverPanelClass, "min-w-(--ui-menu-min) p-4 z-dropdown");

export const menuItemClass = cx(
  "flex items-center gap-8 h-control-lg px-8 rounded-control text-text-primary cursor-pointer outline-none select-none",
  "data-highlighted:bg-bg-hover data-[state=open]:bg-bg-hover data-disabled:opacity-disabled data-disabled:cursor-not-allowed",
  "pointer-coarse:min-h-target-coarse [&_svg]:text-text-secondary",
);

const dangerClass = cx("text-danger-text [&_svg]:text-danger");
const headClass = cx("px-8 pt-6 pb-2 text-text-11 font-medium text-text-secondary");
const sepClass = cx("h-(--stroke-width-hairline) my-4 bg-border-subtle");

function ItemBody({ item }: { item: MenuItem }) {
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

type Parts = typeof RDropdownMenu | typeof RContextMenu;

function renderItems(P: Parts, items: MenuItem[]): ReactNode {
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

/** A short list of actions from a button. Arrow keys move, typing jumps, Enter selects, Esc closes. */
export function DropdownMenu({
  label,
  icon,
  items,
  defaultOpen,
  open,
  onOpenChange,
}: DropdownMenuProps): ReactElement {
  return (
    <RDropdownMenu.Root
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
      modal={false}
    >
      <RDropdownMenu.Trigger className={buttonClass()}>
        {icon ? <Icon name={icon} size={14} /> : null}
        {label}
        <Icon name="ChevronDown" size={14} />
      </RDropdownMenu.Trigger>
      <RDropdownMenu.Portal>
        <RDropdownMenu.Content
          className={menuClass}
          sideOffset={4}
          align="start"
          collisionPadding={16}
        >
          {renderItems(RDropdownMenu, items)}
        </RDropdownMenu.Content>
      </RDropdownMenu.Portal>
    </RDropdownMenu.Root>
  );
}

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

/** Moves between every org a person works with; the marketplace sits at the bottom. */
export function OrgSwitcher({
  current,
  heading,
  orgs,
  onSelect,
  onMarketplace,
  defaultOpen,
}: OrgSwitcherProps): ReactElement {
  const t = useT();
  return (
    <RDropdownMenu.Root {...(defaultOpen === undefined ? {} : { defaultOpen })} modal={false}>
      <RDropdownMenu.Trigger
        aria-label={current}
        className={cx(
          "flex items-center justify-between gap-8 w-(--ui-orgsw) max-w-full h-row-default px-8 rounded-control",
          "bg-transparent text-text-primary cursor-pointer hover:bg-bg-hover pointer-coarse:min-h-target-coarse",
        )}
      >
        <BrandMark name={current} size="sm" />
        <Icon name="ChevronsUpDown" size={14} color="var(--color-text-secondary)" />
      </RDropdownMenu.Trigger>
      <RDropdownMenu.Portal>
        <RDropdownMenu.Content
          className={cx(menuClass, "w-(--ui-orgsw)")}
          sideOffset={4}
          align="start"
          collisionPadding={16}
        >
          <RDropdownMenu.Label className={headClass}>{heading}</RDropdownMenu.Label>
          <RDropdownMenu.RadioGroup value={current} onValueChange={(name) => onSelect?.(name)}>
            {orgs.map((o) => (
              <RDropdownMenu.RadioItem
                key={o.name}
                value={o.name}
                className={cx(menuItemClass, "h-row-comfortable")}
              >
                <BrandMark name={o.name} size="sm" iconOnly />
                <span className="flex flex-1 flex-col">
                  <span>{o.name}</span>
                  <span className="text-text-12 text-text-secondary">{o.role}</span>
                </span>
                <RDropdownMenu.ItemIndicator>
                  <Icon name="Check" size={14} />
                </RDropdownMenu.ItemIndicator>
                {o.name !== current && o.badge ? <Badge count={o.badge} tone="accent" /> : null}
              </RDropdownMenu.RadioItem>
            ))}
          </RDropdownMenu.RadioGroup>
          <RDropdownMenu.Separator className={sepClass} />
          <RDropdownMenu.Item
            className={menuItemClass}
            {...(onMarketplace ? { onSelect: onMarketplace } : {})}
          >
            <Icon name="Compass" />
            <span>{t("org.marketplace")}</span>
          </RDropdownMenu.Item>
        </RDropdownMenu.Content>
      </RDropdownMenu.Portal>
    </RDropdownMenu.Root>
  );
}
