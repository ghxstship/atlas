import { type ReactNode } from "react";
import type {
  ChecklistRunnerProps as ReferenceChecklistRunnerProps,
  ClockButtonProps as ReferenceClockButtonProps,
  DaySheetViewProps as ReferenceDaySheetViewProps,
  ForceUpdateScreenProps as ReferenceForceUpdateScreenProps,
  LiveActivityProps as ReferenceLiveActivityProps,
  OfflineBannerProps as ReferenceOfflineBannerProps,
  PhotoCaptureProps as ReferencePhotoCaptureProps,
  QuickIncidentSheetProps as ReferenceQuickIncidentSheetProps,
  ScanSheetProps as ReferenceScanSheetProps,
  ShiftCardProps as ReferenceShiftCardProps,
  SignaturePadProps as ReferenceSignaturePadProps,
  SyncConflictSheetProps as ReferenceSyncConflictSheetProps,
} from "../types/reference";

/**
 * Compass components on the web (RRR-75): the same surfaces Compass draws natively in
 * @xos/ui-native, for Atlas previews, the Gateway crew view and Storybook. Each one marks its root
 * `xos-compass`, which raises every target to touch-min (48 pt). Props are the reference contracts
 * plus the callbacks a product screen needs; `frame` draws the documentation phone frame and is for
 * previews only.
 */

export type ClockButtonProps = ReferenceClockButtonProps;

export type ScanSheetProps = ReferenceScanSheetProps & {
  onModeChange?: (mode: ReferenceScanSheetProps["mode"]) => void;
  onDone?: () => void;
  onNfc?: () => void;
  onTorch?: () => void;
  /** The live camera feed, drawn inside the viewfinder under the reticle. */
  camera?: ReactNode;
};

export type OfflineBannerProps = ReferenceOfflineBannerProps;

export type QuickIncidentSheetProps = ReferenceQuickIncidentSheetProps & {
  onSelect?: (label: string) => void;
};

export type ChecklistRunnerProps = ReferenceChecklistRunnerProps & {
  onResult?: (code: string, result: "pass" | "fail") => void;
  onAddPhoto?: (code: string) => void;
  onNoteChange?: (code: string, note: string) => void;
};

export type ShiftCardProps = ReferenceShiftCardProps;

export type DaySheetViewProps = ReferenceDaySheetViewProps & {
  onCall?: (name: string) => void;
  onMessage?: (name: string) => void;
};

export type SignaturePadProps = ReferenceSignaturePadProps & {
  /** A PNG data URL of the signature, or null after Clear. */
  onChange?: (signature: string | null) => void;
};

export type PhotoCaptureProps = ReferencePhotoCaptureProps & {
  onCapture?: () => void;
  onAnnotate?: () => void;
  onDone?: () => void;
  camera?: ReactNode;
};

export type LiveActivityProps = ReferenceLiveActivityProps & {
  /** Break, or End Break while on break. */
  onToggleBreak?: () => void;
  onClockOut?: () => void;
};

export type ForceUpdateScreenProps = ReferenceForceUpdateScreenProps & {
  onUpdate?: () => void;
};

export type SyncConflictSheetProps = ReferenceSyncConflictSheetProps & {
  onKeep?: (choice: "mine" | "theirs") => void;
};
