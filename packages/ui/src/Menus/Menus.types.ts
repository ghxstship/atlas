import type { ReactNode } from "react";
import type { ContextMenu as RContextMenu, DropdownMenu as RDropdownMenu } from "radix-ui";
import type {
  ContextMenuProps as ReferenceContextMenuProps,
  DropdownMenuProps as ReferenceDropdownMenuProps,
  MenuItem as ReferenceMenuItem,
  OrgSwitcherProps as ReferenceOrgSwitcherProps,
} from "../types/reference";

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
  /**
   * Below md, a trigger with an icon shows only the icon; the label stays as its accessible name
   * (the account menu in a phone's top bar).
   */
  compact?: boolean;
};

export type ContextMenuProps = Omit<ReferenceContextMenuProps, "items"> & {
  items: MenuItem[];
  /** The region that opens the menu on right-click, long press or Shift+F10. Without it the menu renders on its own. */
  children?: ReactNode;
  /**
   * Opens the menu at a viewport point instead of over `children`: where the pointer was, or a
   * focused cell's corner from the keyboard. The page opens it (a table row's right-click or
   * Shift+F10), so the menu code can load on demand; `onClose` runs when it closes.
   */
  at?: { x: number; y: number };
  onClose?: () => void;
  /** Takes focus back when a point menu closes; the element that opened it, such as a table cell. */
  returnFocus?: HTMLElement | null;
};

export type OrgSwitcherProps = ReferenceOrgSwitcherProps & {
  onSelect?: (name: string) => void;
  onMarketplace?: () => void;
  defaultOpen?: boolean;
};

export type Parts = typeof RDropdownMenu | typeof RContextMenu;
