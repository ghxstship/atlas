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

export type Parts = typeof RDropdownMenu | typeof RContextMenu;
