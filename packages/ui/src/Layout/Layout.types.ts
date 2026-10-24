import { type CSSProperties, type Ref, type ReactNode } from "react";
import type {
  AppShellProps as ReferenceAppShellProps,
  PageHeaderProps as ReferencePageHeaderProps,
  ResizablePanelProps as ReferenceResizablePanelProps,
  ScrollRegionProps as ReferenceScrollRegionProps,
  SplitViewProps as ReferenceSplitViewProps,
  StepperProps as ReferenceStepperProps,
} from "../types/reference";

export type AppShellProps = ReferenceAppShellProps & {
  /** The phone bottom bar (TabBar), shown below md. */
  mobileNav?: ReactNode;
  /**
   * Whether the navigation drawer is open below lg, for a shell that opens it from elsewhere too
   * (the bottom bar's Menu tab). Uncontrolled when omitted.
   */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
};

export type PageHeaderProps = ReferencePageHeaderProps;

export type ResizablePanelProps = ReferenceResizablePanelProps & {
  onResize?: (width: number) => void;
  /** Keyboard step in pixels; 16 by default. */
  step?: number;
};

export type ScrollRegionProps = ReferenceScrollRegionProps & {
  /** Classes for the scrolling element itself. */
  className?: string;
  /** Classes for the frame around it that holds the edge fades (its place in a flex row, say). */
  frameClassName?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
};

export type SplitViewProps = ReferenceSplitViewProps & {
  onSelect?: (index: number) => void;
};

export type StepperProps = ReferenceStepperProps;
