import { useEffect, useState, type ReactElement } from "react";
import { View } from "react-native";
import { useTheme, type XosNativeTheme } from "../theme/index.ts";
import type {
  AlertTone,
  BannerProps,
  EmptyStateProps,
  ErrorStateProps,
  InlineAlertProps,
  RefusalNoticeProps,
  ToastProps,
  UndoToastProps,
} from "../types.ts";
import { Icon, IconInk, Text } from "./foundations.tsx";
import { Button, IconButton } from "./primitives.tsx";

const TONE_ICON: Record<AlertTone, string> = {
  info: "Info",
  success: "CircleCheck",
  warning: "TriangleAlert",
  danger: "OctagonAlert",
};

function toneInk(theme: XosNativeTheme, tone: AlertTone): string {
  switch (tone) {
    case "success":
      return theme.color.success;
    case "warning":
      return theme.color.warning;
    case "danger":
      return theme.color.danger;
    default:
      return theme.color.accentDefault;
  }
}

/** A page-wide message with an optional action and dismiss. */
export function Banner({
  tone = "info",
  icon,
  message,
  actionLabel,
  onAction,
  onDismiss,
  dismissLabel,
  testID,
}: BannerProps): ReactElement {
  const theme = useTheme();
  const ink = toneInk(theme, tone);
  return (
    <View
      role={tone === "danger" || tone === "warning" ? "alert" : "summary"}
      {...(testID === undefined ? {} : { testID })}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space["8"],
        paddingHorizontal: theme.space["12"],
        paddingVertical: theme.space["8"],
        borderLeftWidth: theme.strokeWidth.accent,
        borderLeftColor: ink,
        backgroundColor: theme.color.bgSurface,
      }}
    >
      <IconInk name={icon ?? TONE_ICON[tone]} size={20} color={ink} />
      <View style={{ flex: 1 }}>
        <Text variant="text14">{message}</Text>
      </View>
      {actionLabel && onAction ? (
        <Button variant="ghost" label={actionLabel} onPress={onAction} />
      ) : null}
      {onDismiss && dismissLabel ? (
        <IconButton icon="X" label={dismissLabel} onPress={onDismiss} />
      ) : null}
    </View>
  );
}

/** A message inside a form or section. */
export function InlineAlert({
  tone = "info",
  title,
  message,
  testID,
}: InlineAlertProps): ReactElement {
  const theme = useTheme();
  const ink = toneInk(theme, tone);
  return (
    <View
      role={tone === "danger" ? "alert" : "summary"}
      {...(testID === undefined ? {} : { testID })}
      style={{
        flexDirection: "row",
        gap: theme.space["8"],
        padding: theme.space["12"],
        borderRadius: theme.radius.card,
        borderWidth: theme.controlBorderWidth,
        borderColor: ink,
        backgroundColor: theme.color.bgSurface,
      }}
    >
      <IconInk name={TONE_ICON[tone]} size={20} color={ink} />
      <View style={{ flex: 1, gap: theme.space["2"] }}>
        {title ? <Text variant="heading16">{title}</Text> : null}
        <Text variant="text14">{message}</Text>
      </View>
    </View>
  );
}

function ToastFrame({
  children,
  testID,
}: {
  children: ReactElement[];
  testID?: string | undefined;
}) {
  const theme = useTheme();
  return (
    <View
      role="alert"
      {...(testID === undefined ? {} : { testID })}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space["8"],
        minHeight: theme.density.touchMin,
        paddingLeft: theme.space["16"],
        paddingRight: theme.space["4"],
        borderRadius: theme.radius.card,
        backgroundColor: theme.color.bgRaised,
        boxShadow: theme.shadow.menu,
      }}
    >
      {children}
    </View>
  );
}

/** A short confirmation with an optional action. */
export function Toast({ message, actionLabel, onAction, testID }: ToastProps): ReactElement {
  return (
    <ToastFrame testID={testID}>
      <View style={{ flex: 1 }}>
        <Text variant="text14">{message}</Text>
      </View>
      {actionLabel && onAction ? (
        <Button variant="ghost" label={actionLabel} onPress={onAction} />
      ) : (
        <View />
      )}
    </ToastFrame>
  );
}

/** A confirmation with Undo and a countdown; Undo stays available until the count reaches zero. */
export function UndoToast({
  message,
  undoLabel,
  seconds = 8,
  onUndo,
  testID,
}: UndoToastProps): ReactElement {
  const theme = useTheme();
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return undefined;
    const id = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);
  return (
    <ToastFrame testID={testID}>
      <View style={{ flex: 1 }}>
        <Text variant="text14">{message}</Text>
      </View>
      {left > 0 ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["4"] }}>
          <Text variant="text12" tone="secondary">
            {left}
          </Text>
          <Button variant="ghost" label={undoLabel} onPress={onUndo} />
        </View>
      ) : (
        <View />
      )}
    </ToastFrame>
  );
}

/** Nothing here yet: one sentence naming the next action, and the button that takes it. */
export function EmptyState({
  sentence,
  actionLabel,
  icon,
  onAction,
  testID,
}: EmptyStateProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{ alignItems: "center", gap: theme.space["12"], padding: theme.space["24"] }}
    >
      {icon ? <Icon name={icon} size={28} tone="secondary" /> : null}
      <Text tone="secondary">{sentence}</Text>
      <Button variant="primary" label={actionLabel} {...(onAction ? { onPress: onAction } : {})} />
    </View>
  );
}

/** Something failed: what happened, a retry, and a reference to quote to support. */
export function ErrorState({
  title,
  sentence,
  actionLabel,
  reference,
  onRetry,
  testID,
}: ErrorStateProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      role="alert"
      {...(testID === undefined ? {} : { testID })}
      style={{ alignItems: "center", gap: theme.space["12"], padding: theme.space["24"] }}
    >
      <IconInk name="TriangleAlert" size={28} color={theme.color.danger} />
      <Text variant="heading20" heading>
        {title}
      </Text>
      <Text tone="secondary">{sentence}</Text>
      {actionLabel && onRetry ? <Button label={actionLabel} onPress={onRetry} /> : null}
      {reference ? (
        <Text variant="mono13" tone="tertiary">
          {reference}
        </Text>
      ) : null}
    </View>
  );
}

const OUTCOME: Record<RefusalNoticeProps["outcome"], { icon: string; tone: AlertTone }> = {
  NO_ANSWER: { icon: "CircleHelp", tone: "warning" },
  UNRATIFIED: { icon: "Clock", tone: "info" },
  REFUSE: { icon: "OctagonAlert", tone: "danger" },
};

/** A refused, unanswered or unratified request (NO ANSWER, UNRATIFIED, REFUSE) with its reason. */
export function RefusalNotice({
  outcome,
  title,
  reason,
  actionLabel,
  onAction,
  testID,
}: RefusalNoticeProps): ReactElement {
  const theme = useTheme();
  const { icon, tone } = OUTCOME[outcome];
  const ink = toneInk(theme, tone);
  return (
    <View
      role="alert"
      {...(testID === undefined ? {} : { testID })}
      style={{
        gap: theme.space["8"],
        padding: theme.space["16"],
        borderRadius: theme.radius.card,
        borderWidth: theme.controlBorderWidth,
        borderColor: ink,
        backgroundColor: theme.color.bgSurface,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}>
        <IconInk name={icon} size={20} color={ink} />
        <Text variant="mono13" tone="secondary">
          {outcome.replace("_", " ")}
        </Text>
      </View>
      <Text variant="heading16" heading>
        {title}
      </Text>
      <Text variant="text14">{reason}</Text>
      {actionLabel && onAction ? <Button label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}
