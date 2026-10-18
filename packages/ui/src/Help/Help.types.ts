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
  onSend?: (feedback: { text: string; screenshot: boolean }) => void;
  onCancel?: () => void;
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
