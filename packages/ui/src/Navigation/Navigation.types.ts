import { type ReactNode } from "react";
import type {
  AccordionProps as ReferenceAccordionProps,
  BreadcrumbsProps as ReferenceBreadcrumbsProps,
  IconName,
  PaginationProps as ReferencePaginationProps,
  SegmentedControlProps as ReferenceSegmentedControlProps,
  SidebarProps as ReferenceSidebarProps,
  TabBarProps as ReferenceTabBarProps,
  TabsProps as ReferenceTabsProps,
  TopNavProps as ReferenceTopNavProps,
} from "../types/reference";

export type TabsProps = ReferenceTabsProps & {
  /** Panel content per tab value; each renders as a tabpanel labeled by its tab. */
  panels?: Record<string, ReactNode>;
};

export type SegmentedControlProps = ReferenceSegmentedControlProps;

export type AccordionProps = ReferenceAccordionProps & {
  /**
   * Keeps closed sections in the DOM, hidden, instead of unmounting them. Use it for the More fields
   * pattern inside a form, so collapsed fields keep their values and still submit with the form.
   */
  keepMounted?: boolean;
};

export type BreadcrumbsProps = ReferenceBreadcrumbsProps;

export type PaginationProps = ReferencePaginationProps;

export interface NavItem {
  label: string;
  icon?: IconName;
  badge?: number;
  href?: string;
  onSelect?: () => void;
}

export type SidebarProps = Omit<ReferenceSidebarProps, "groups"> & {
  groups: { label?: string; collapsed?: boolean; items: NavItem[] }[];
};

export type TopNavProps = Omit<ReferenceTopNavProps, "items"> & {
  items: (NavItem & { icon: IconName })[];
  onSearch?: () => void;
  onHelp?: () => void;
  onAccount?: () => void;
};

export type TabBarProps = Omit<ReferenceTabBarProps, "items"> & {
  items: (NavItem & { icon: IconName })[];
};
