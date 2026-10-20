import type {
  BannerProps as ReferenceBannerProps,
  EmptyStateProps as ReferenceEmptyStateProps,
  ErrorStateProps as ReferenceErrorStateProps,
  InlineAlertProps as ReferenceInlineAlertProps,
  RefusalNoticeProps as ReferenceRefusalNoticeProps,
  ToastProps as ReferenceToastProps,
  UndoToastProps as ReferenceUndoToastProps,
} from "../types/reference";

export type EmptyStateProps = ReferenceEmptyStateProps & {
  /**
   * Weight of the action button. Primary by default; pass "secondary" when the page header already
   * carries the same primary action, so the screen keeps one primary action (Section 18 gate 27).
   */
  actionVariant?: "primary" | "secondary";
};

export type ErrorStateProps = ReferenceErrorStateProps;

export type RefusalNoticeProps = ReferenceRefusalNoticeProps & {
  /**
   * The outcome in words ("Refused"), shown instead of the outcome code, so the code never stands
   * alone in product copy (Section 11.10 item 2). Without it the chip shows the code.
   */
  outcomeLabel?: string;
};

export type InlineAlertProps = ReferenceInlineAlertProps;

export type BannerProps = ReferenceBannerProps;

export type ToastProps = ReferenceToastProps;

export type UndoToastProps = ReferenceUndoToastProps & {
  /** Called once when the countdown ends without an undo. */
  onExpire?: () => void;
};

export type Tone = "info" | "success" | "warning" | "danger";
