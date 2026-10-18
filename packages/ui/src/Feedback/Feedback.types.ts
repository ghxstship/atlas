import type {
  BannerProps as ReferenceBannerProps,
  EmptyStateProps as ReferenceEmptyStateProps,
  ErrorStateProps as ReferenceErrorStateProps,
  InlineAlertProps as ReferenceInlineAlertProps,
  RefusalNoticeProps as ReferenceRefusalNoticeProps,
  ToastProps as ReferenceToastProps,
  UndoToastProps as ReferenceUndoToastProps,
} from "../types/reference";

export type EmptyStateProps = ReferenceEmptyStateProps;

export type ErrorStateProps = ReferenceErrorStateProps;

export type RefusalNoticeProps = ReferenceRefusalNoticeProps;

export type InlineAlertProps = ReferenceInlineAlertProps;

export type BannerProps = ReferenceBannerProps;

export type ToastProps = ReferenceToastProps;

export type UndoToastProps = ReferenceUndoToastProps & {
  /** Called once when the countdown ends without an undo. */
  onExpire?: () => void;
};

export type Tone = "info" | "success" | "warning" | "danger";
