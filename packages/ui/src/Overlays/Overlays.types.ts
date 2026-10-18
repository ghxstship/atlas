import { type ReactElement, type ReactNode } from "react";
import type {
  DialogProps as ReferenceDialogProps,
  DrawerProps as ReferenceDrawerProps,
  HoverCardProps as ReferenceHoverCardProps,
  PopoverProps as ReferencePopoverProps,
  ShortcutSheetProps as ReferenceShortcutSheetProps,
  SidePeekProps as ReferenceSidePeekProps,
  TooltipProps as ReferenceTooltipProps,
} from "../types/reference";

/** Open state shared by every overlay: controlled with `open`, or mounted open unless a `trigger` opens it. */
export interface OverlayControl {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the overlay. Without one, the overlay renders open while mounted. */
  trigger?: ReactElement;
}

export type DialogProps = ReferenceDialogProps &
  OverlayControl & {
    /** One sentence under the title, announced with it. */
    description?: ReactNode;
  };

export type DrawerProps = ReferenceDrawerProps & OverlayControl;

export type SidePeekProps = ReferenceSidePeekProps &
  OverlayControl & {
    onOpenFull?: () => void;
    onCopyLink?: () => void;
    /** Opens the state menu from the state chip. */
    onStateClick?: () => void;
  };

export type ShortcutSheetProps = ReferenceShortcutSheetProps & OverlayControl;

export type PopoverProps = ReferencePopoverProps &
  Omit<OverlayControl, "defaultOpen"> & { defaultOpen?: boolean };

export type HoverCardProps = ReferenceHoverCardProps & {
  /** The record key or link the card previews; without it the card renders on its own. */
  children?: ReactElement;
  openDelay?: number;
};

export type TooltipProps = ReferenceTooltipProps & {
  /** The control the tooltip describes; without it the bubble renders on its own. */
  children?: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  /** Hover delay in milliseconds; 500 by default. */
  delay?: number;
};
