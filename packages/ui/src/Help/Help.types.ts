import type { ReactNode } from "react";
import type {
  FeedbackWidgetProps as ReferenceFeedbackWidgetProps,
  HelpPanelProps as ReferenceHelpPanelProps,
  NotificationCenterProps as ReferenceNotificationCenterProps,
  NotificationItem,
  OnboardingChecklistProps as ReferenceOnboardingChecklistProps,
  ShortcutEditorProps as ReferenceShortcutEditorProps,
  WhatsNewProps as ReferenceWhatsNewProps,
} from "../types/reference";

export type NotificationCenterProps = ReferenceNotificationCenterProps & {
  onAction?: (item: NotificationItem) => void;
  onDone?: (item: NotificationItem) => void;
  onSnooze?: (item: NotificationItem) => void;
};

export type OnboardingChecklistProps = ReferenceOnboardingChecklistProps & {
  onAction?: (label: string) => void;
};

export type WhatsNewProps = ReferenceWhatsNewProps;

export type FeedbackWidgetProps = ReferenceFeedbackWidgetProps & {
  /**
   * Sends the feedback. A promise holds the widget in its sending state; false keeps the text and says it did not
   * send, so the person can try again.
   */
  onSend?: (feedback: { text: string; screenshot: boolean }) => Promise<boolean> | undefined;
  onCancel?: () => void;
  /** Replaces the screenshot checkbox, for an app that attaches a file the person chooses (A96). */
  screenshotField?: ReactNode;
  /** What goes with the message, shown under the privacy note so nothing is sent unseen (Section 11.7). */
  context?: ReactNode;
  /** The thanks once sent, for example with the reference the platform team quotes. */
  thanks?: string;
};

export type ShortcutEditorProps = ReferenceShortcutEditorProps & {
  onChange?: (action: string) => void;
  onReset?: (action: string) => void;
};

export type HelpPanelProps = ReferenceHelpPanelProps & {
  onSearch?: (query: string) => void;
  onArticle?: (title: string) => void;
  onAsk?: (question: string) => void;
  onWhatsNew?: () => void;
  onContact?: () => void;
  onClose?: () => void;
};
