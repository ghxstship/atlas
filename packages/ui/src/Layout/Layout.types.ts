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
};

export type PageHeaderProps = ReferencePageHeaderProps;

export type ResizablePanelProps = ReferenceResizablePanelProps & {
  onResize?: (width: number) => void;
  /** Keyboard step in pixels; 16 by default. */
  step?: number;
};

export type ScrollRegionProps = ReferenceScrollRegionProps & {
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
};

export type SplitViewProps = ReferenceSplitViewProps & {
  onSelect?: (index: number) => void;
};

export type StepperProps = ReferenceStepperProps;
