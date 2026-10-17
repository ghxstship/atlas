/**
 * Layout, data display, feedback and overlays for the @xos/ui-native seam.
 */
import type {
  BadgeProps,
  BannerProps,
  CardProps,
  EmptyStateProps,
  ErrorStateProps,
  InlineAlertProps,
  ListRowProps,
  ProgressBarProps,
  RefusalNoticeProps,
  ScreenProps,
  SheetProps,
  SkeletonProps,
  TabBarProps,
  TagProps,
  ToastProps,
} from "@xos/ui-native";
import { announce, useReducedMotion } from "@xos/ui-native";
import { useTheme, type XosNativeTheme } from "@xos/ui-native/theme";
import { useEffect, type ReactElement } from "react";
import { Modal, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, gloveSlop, Icon, Text, tid } from "./primitives";

export function Screen({
  title,
  scroll = true,
  refreshing,
  onRefresh,
  footer,
  children,
  testID,
}: ScreenProps): ReactElement {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Without scrolling the body fills the screen, so a flex child (the scan sheet's camera) gets the room
  // left; it collapsed to nothing before, and its Done button drew over the manual entry.
  const body = (
    <View
      style={{ padding: theme.space["16"], gap: theme.space["16"], ...(scroll ? {} : { flex: 1 }) }}
    >
      {title ? (
        <Text variant="heading24" heading>
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
  return (
    <View
      testID={testID}
      style={{ flex: 1, backgroundColor: theme.color.bgCanvas, paddingTop: insets.top }}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: theme.space["32"] }}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={Boolean(refreshing)}
                onRefresh={onRefresh}
                tintColor={theme.color.textSecondary}
              />
            ) : undefined
          }
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{body}</View>
      )}
      {footer ? (
        <View
          style={{
            padding: theme.space["16"],
            borderTopWidth: theme.strokeWidth.hairline,
            borderTopColor: theme.color.borderSubtle,
            backgroundColor: theme.color.bgSurface,
          }}
        >
          {footer}
        </View>
      ) : null}
    </View>
  );
}

export function Card({ title, meta, footer, onPress, children, testID }: CardProps): ReactElement {
  const theme = useTheme();
  const content = (
    <View style={{ gap: theme.space["8"] }}>
      {title ? (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            gap: theme.space["8"],
          }}
        >
          {/* The title takes the room left and wraps, so a long one never pushes the status tag off the
              card (seen on the simulator with long incident titles). */}
          <View style={{ flex: 1, flexShrink: 1 }}>
            <Text variant="heading16" heading>
              {title}
            </Text>
          </View>
          {meta}
        </View>
      ) : null}
      {children}
      {footer}
    </View>
  );
  const style = {
    padding: theme.space["16"],
    borderRadius: theme.radius.card,
    backgroundColor: theme.color.bgSurface,
    borderWidth: theme.strokeWidth.hairline,
    borderColor: theme.color.borderSubtle,
  };
  return onPress ? (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={style}>
      {content}
    </Pressable>
  ) : (
    <View testID={testID} style={style}>
      {content}
    </View>
  );
}

export function ListRow({
  title,
  subtitle,
  icon,
  trailing,
  onPress,
  swipeStart,
  swipeEnd,
  testID,
}: ListRowProps): ReactElement {
  const theme = useTheme();
  // Every swipe has a visible button equivalent (Section 11.10 item 6): actions render as trailing buttons.
  const actions = [swipeStart, swipeEnd].filter((a): a is NonNullable<typeof a> => a !== undefined);
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: theme.density.touchMin + theme.space["8"],
        gap: theme.space["12"],
        borderBottomWidth: theme.strokeWidth.hairline,
        borderBottomColor: theme.color.borderSubtle,
      }}
      accessibilityActions={actions.map((a) => ({ name: a.label, label: a.label }))}
      onAccessibilityAction={(e) =>
        actions.find((a) => a.label === e.nativeEvent.actionName)?.onAction()
      }
    >
      <Pressable
        accessibilityRole={onPress ? "button" : undefined}
        onPress={onPress}
        disabled={!onPress}
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: theme.space["12"],
          paddingVertical: theme.space["8"],
        }}
      >
        {icon ? <Icon name={icon} /> : null}
        <View style={{ flex: 1, gap: theme.space["2"] }}>
          <Text>{title}</Text>
          {subtitle ? (
            <Text variant="text13" tone="secondary">
              {subtitle}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {/* Outside the row's Pressable: an accessible Pressable merges its children into one element, so a
          trailing button (an inspection's Start) inside it was unreachable by VoiceOver and Switch
          Control. */}
      {trailing}
      {actions.map((a) => (
        <Pressable
          key={a.label}
          accessibilityRole="button"
          accessibilityLabel={a.label}
          onPress={a.onAction}
          hitSlop={gloveSlop(theme)}
          style={{
            minWidth: theme.density.touchMin,
            minHeight: theme.density.touchMin,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon
            name={a.icon}
            tone={a.tone === "danger" ? "danger" : a.tone === "success" ? "success" : "accent"}
          />
        </Pressable>
      ))}
    </View>
  );
}

export function Tag({ tone = "neutral", label, testID }: TagProps): ReactElement {
  const theme = useTheme();
  const color = tone === "neutral" ? "secondary" : tone === "accent" ? "accent" : tone;
  return (
    <View
      testID={testID}
      style={{
        paddingHorizontal: theme.space["8"],
        paddingVertical: theme.space["2"],
        borderRadius: theme.radius.chip,
        backgroundColor: theme.color.bgRaised,
      }}
    >
      <Text variant="label13" tone={color}>
        {label}
      </Text>
    </View>
  );
}

export function Badge({ count, tone = "neutral", label, testID }: BadgeProps): ReactElement | null {
  const theme = useTheme();
  if (count <= 0) return null;
  const bg =
    tone === "danger"
      ? theme.color.danger
      : tone === "accent"
        ? theme.color.accentDefault
        : theme.color.bgRaised;
  return (
    <View
      testID={testID}
      accessibilityLabel={label}
      style={{
        minWidth: theme.space["20"],
        paddingHorizontal: theme.space["6"],
        borderRadius: theme.radius.pill,
        backgroundColor: bg,
        alignItems: "center",
      }}
    >
      <Text variant="label13">{count > 99 ? "99+" : String(count)}</Text>
    </View>
  );
}

export function ProgressBar({ label, value, testID }: ProgressBarProps): ReactElement {
  const theme = useTheme();
  const pct = Math.max(0, Math.min(100, value));
  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={{ gap: theme.space["4"] }}
    >
      <Text variant="text13" tone="secondary">
        {label}
      </Text>
      <View
        style={{
          height: theme.space["6"],
          borderRadius: theme.radius.pill,
          backgroundColor: theme.color.bgRaised,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${pct}%`,
            height: theme.space["6"],
            backgroundColor: theme.color.accentDefault,
          }}
        />
      </View>
    </View>
  );
}

export function Skeleton({
  width = "100%",
  height,
  lines = 1,
  testID,
}: SkeletonProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ gap: theme.space["8"] }}
    >
      {Array.from({ length: lines }, (_, i) => (
        <View
          key={i}
          style={{
            width,
            height: height ?? theme.space["16"],
            borderRadius: theme.radius.chip,
            backgroundColor: theme.color.bgRaised,
          }}
        />
      ))}
    </View>
  );
}

function alertColors(theme: XosNativeTheme, tone: NonNullable<BannerProps["tone"]>) {
  if (tone === "danger") return { border: theme.color.danger, text: "danger" as const };
  if (tone === "warning") return { border: theme.color.warning, text: "warning" as const };
  if (tone === "success") return { border: theme.color.success, text: "success" as const };
  return { border: theme.color.accentDefault, text: "accent" as const };
}

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
  const colors = alertColors(theme, tone);
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space["12"],
        padding: theme.space["12"],
        borderRadius: theme.radius.card,
        borderWidth: theme.controlBorderWidth,
        borderColor: colors.border,
        backgroundColor: theme.color.bgSurface,
      }}
    >
      {icon ? <Icon name={icon} tone={colors.text} /> : null}
      <View style={{ flex: 1 }}>
        <Text variant="text14">{message}</Text>
      </View>
      {actionLabel && onAction ? (
        <Button label={actionLabel} variant="ghost" onPress={onAction} />
      ) : null}
      {onDismiss ? (
        <Button label={dismissLabel} variant="ghost" icon="x" onPress={onDismiss} />
      ) : null}
    </View>
  );
}

export function InlineAlert({
  tone = "info",
  title,
  message,
  testID,
}: InlineAlertProps): ReactElement {
  const theme = useTheme();
  const colors = alertColors(theme, tone);
  return (
    <View
      testID={testID}
      style={{
        gap: theme.space["4"],
        paddingLeft: theme.space["12"],
        borderLeftWidth: theme.strokeWidth.accent,
        borderLeftColor: colors.border,
      }}
    >
      {title ? (
        <Text variant="heading16" tone={colors.text}>
          {title}
        </Text>
      ) : null}
      <Text variant="text14">{message}</Text>
    </View>
  );
}

export function Toast({ message, actionLabel, onAction, testID }: ToastProps): ReactElement {
  // A toast is a status message: VoiceOver hears it only when it is announced (A23-004).
  useEffect(() => {
    announce(message);
  }, [message]);
  return (
    <Banner
      {...tid(testID)}
      message={message}
      {...(actionLabel && onAction ? { actionLabel, onAction } : {})}
    />
  );
}

export function EmptyState({
  sentence,
  actionLabel,
  icon = "inbox",
  onAction,
  testID,
}: EmptyStateProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={{ alignItems: "center", gap: theme.space["12"], paddingVertical: theme.space["32"] }}
    >
      <Icon name={icon} size={28} tone="tertiary" />
      <Text tone="secondary">{sentence}</Text>
      {onAction ? <Button label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}

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
      testID={testID}
      accessibilityRole="alert"
      style={{ gap: theme.space["12"], paddingVertical: theme.space["24"] }}
    >
      <Text variant="heading20" heading tone="danger">
        {title}
      </Text>
      <Text tone="secondary">{sentence}</Text>
      {reference ? (
        <Text variant="mono13" tone="tertiary">
          {reference}
        </Text>
      ) : null}
      {actionLabel && onRetry ? <Button label={actionLabel} onPress={onRetry} /> : null}
    </View>
  );
}

export function RefusalNotice({
  outcome,
  title,
  reason,
  actionLabel,
  onAction,
  testID,
}: RefusalNoticeProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={{
        gap: theme.space["12"],
        padding: theme.space["16"],
        borderRadius: theme.radius.card,
        backgroundColor: theme.color.bgSurface,
        borderWidth: theme.controlBorderWidth,
        borderColor: theme.color.borderStrong,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}>
        <Icon name={outcome === "REFUSE" ? "ban" : "circle-help"} tone="warning" />
        <Text variant="heading16" heading>
          {title}
        </Text>
      </View>
      <Text tone="secondary">{reason}</Text>
      {actionLabel && onAction ? (
        <Button label={actionLabel} variant="secondary" onPress={onAction} />
      ) : null}
    </View>
  );
}

/** Sheets over pages on phones (Section 11.10 item 7). */
export function Sheet({
  open,
  title,
  onClose,
  closeLabel,
  footer,
  children,
  testID,
}: SheetProps): ReactElement {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Reduce Motion: the sheet fades in instead of sliding up (A23-008).
  const still = useReducedMotion();
  return (
    <Modal
      visible={open}
      animationType={still ? "fade" : "slide"}
      transparent
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityLabel={closeLabel}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: theme.color.scrim, opacity: theme.opacity.scrimDark }}
      />
      <View
        testID={testID}
        accessibilityViewIsModal
        style={{
          maxHeight: "92%",
          backgroundColor: theme.color.bgRaised,
          borderTopLeftRadius: theme.radius.dialog,
          borderTopRightRadius: theme.radius.dialog,
          paddingBottom: insets.bottom + theme.space["16"],
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            padding: theme.space["16"],
            gap: theme.space["12"],
          }}
        >
          <View style={{ flex: 1 }}>
            <Text variant="heading20" heading>
              {title}
            </Text>
          </View>
          <Button label={closeLabel} variant="ghost" onPress={onClose} />
        </View>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: theme.space["16"], gap: theme.space["16"] }}
        >
          {children}
        </ScrollView>
        {footer ? <View style={{ padding: theme.space["16"] }}>{footer}</View> : null}
      </View>
    </Modal>
  );
}

export function TabBar({
  label,
  items,
  active,
  onSelect,
  center,
  testID,
}: TabBarProps): ReactElement {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        paddingBottom: insets.bottom,
        backgroundColor: theme.color.bgSurface,
        borderTopWidth: theme.strokeWidth.hairline,
        borderTopColor: theme.color.borderSubtle,
      }}
    >
      {items.map((item) => {
        const selected = item.key === active;
        const isCenter = center !== undefined && item.key === "scan";
        return (
          <Pressable
            key={item.key}
            testID={`tab-${item.key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={item.badge ? `${item.label}, ${item.badge}` : item.label}
            onPress={() => (isCenter ? center.onPress() : onSelect(item.key))}
            style={{
              flex: 1,
              minHeight: theme.density.touchMin + theme.space["8"],
              alignItems: "center",
              justifyContent: "center",
              gap: theme.space["2"],
            }}
          >
            <View
              style={
                isCenter
                  ? {
                      padding: theme.space["8"],
                      borderRadius: theme.radius.pill,
                      backgroundColor: theme.color.accentDefault,
                    }
                  : undefined
              }
            >
              <Icon name={item.icon} tone={selected ? "accent" : "secondary"} onAccent={isCenter} />
            </View>
            <Text variant="text12" tone={selected ? "accent" : "secondary"} numberOfLines={1}>
              {item.label}
            </Text>
            {item.badge ? (
              <View style={{ position: "absolute", top: theme.space["4"], right: "25%" }}>
                <Badge count={item.badge} tone="danger" />
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
