import { useMemo, useRef, type ReactElement } from "react";
import { Animated, PanResponder, Pressable, View } from "react-native";
import { useHaptic, useTheme, type XosNativeTheme } from "../theme/index.ts";
import type {
  BadgeProps,
  CardProps,
  ListRowProps,
  StateChipProps,
  TagProps,
  Tone,
} from "../types.ts";
import { IconInk, Icon, Ink, StateIcon, Text } from "./foundations.tsx";

/** Fill and ink for a tone. */
export function toneFill(theme: XosNativeTheme, tone: Tone): { fill: string; ink: string } {
  switch (tone) {
    case "accent":
      return { fill: theme.color.accentDefault, ink: theme.color.accentTextOn };
    case "success":
      return { fill: theme.color.success, ink: theme.color.bgCanvas };
    case "warning":
      return { fill: theme.color.warning, ink: theme.color.bgCanvas };
    case "danger":
      return { fill: theme.color.danger, ink: theme.color.dangerTextOn };
    default:
      return { fill: theme.color.bgHover, ink: theme.color.textPrimary };
  }
}

/** Record state as icon plus label; `compact` keeps the label for assistive technology only. */
export function StateChip({ state, label, compact = false, testID }: StateChipProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      {...(compact ? { role: "img" as const, "aria-label": label } : {})}
      {...(testID === undefined ? {} : { testID })}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: theme.space["6"],
        paddingHorizontal: theme.space["8"],
        paddingVertical: theme.space["2"],
        borderRadius: theme.radius.chip,
        borderWidth: theme.strokeWidth.hairline,
        borderColor: theme.color.borderSubtle,
        backgroundColor: theme.color.bgSurface,
      }}
    >
      <StateIcon state={state} size={20} />
      {compact ? null : <Text variant="label13">{label}</Text>}
    </View>
  );
}

/** A count; `label` is the accessible text (for example "4 unread"). */
export function Badge({ count, tone = "neutral", label, testID }: BadgeProps): ReactElement {
  const theme = useTheme();
  const { fill, ink } = toneFill(theme, tone);
  return (
    <View
      role="img"
      aria-label={label ?? String(count)}
      {...(testID === undefined ? {} : { testID })}
      style={{
        minWidth: theme.space["20"],
        paddingHorizontal: theme.space["4"],
        borderRadius: theme.radius.pill,
        alignItems: "center",
        backgroundColor: fill,
      }}
    >
      <Ink variant="text12" color={ink}>
        {count}
      </Ink>
    </View>
  );
}

/** A short status or category label. */
export function Tag({ tone = "neutral", label, testID }: TagProps): ReactElement {
  const theme = useTheme();
  const { fill, ink } = toneFill(theme, tone);
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: theme.space["6"],
        borderRadius: theme.radius.chip,
        backgroundColor: fill,
      }}
    >
      <Ink variant="text12" color={ink}>
        {label}
      </Ink>
    </View>
  );
}

/** A raised region with an optional title, meta and footer; pressable when `onPress` is set. */
export function Card({ title, meta, footer, onPress, children, testID }: CardProps): ReactElement {
  const theme = useTheme();
  const body = (
    <>
      {title ? (
        <View
          style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space["8"] }}
        >
          <Text variant="heading16" heading>
            {title}
          </Text>
          {meta ? <View>{meta}</View> : null}
        </View>
      ) : null}
      {children}
      {footer ? (
        <View style={{ flexDirection: "row", gap: theme.space["8"] }}>{footer}</View>
      ) : null}
    </>
  );
  const style = {
    gap: theme.space["12"],
    padding: theme.space["16"],
    borderRadius: theme.radius.dialog,
    borderWidth: theme.controlBorderWidth,
    borderColor: theme.color.borderSubtle,
    backgroundColor: theme.color.bgRaised,
  };
  if (!onPress) {
    return (
      <View {...(testID === undefined ? {} : { testID })} style={style}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      role="button"
      onPress={onPress}
      {...(testID === undefined ? {} : { testID })}
      style={({ pressed }) => ({
        ...style,
        backgroundColor: pressed ? theme.color.bgHover : theme.color.bgRaised,
      })}
    >
      {body}
    </Pressable>
  );
}

/**
 * A 48 pt list row. Swipe right runs `swipeStart` (complete), swipe left runs `swipeEnd` (snooze
 * or reassign). Both are also custom accessibility actions, so VoiceOver and TalkBack users reach
 * them without the gesture.
 */
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
  const haptic = useHaptic();
  const offset = useRef(new Animated.Value(0)).current;
  const threshold = theme.density.touchMin * 2;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > theme.space["12"] && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_e, g) => {
          if ((g.dx > 0 && swipeStart) || (g.dx < 0 && swipeEnd)) offset.setValue(g.dx);
        },
        onPanResponderRelease: (_e, g) => {
          if (g.dx > threshold && swipeStart) {
            haptic("success");
            swipeStart.onAction();
          } else if (g.dx < -threshold && swipeEnd) {
            haptic("selection");
            swipeEnd.onAction();
          }
          Animated.timing(offset, {
            toValue: 0,
            duration: theme.duration.base,
            useNativeDriver: true,
          }).start();
        },
      }),
    [offset, swipeStart, swipeEnd, threshold, haptic, theme],
  );
  const actions = [swipeStart, swipeEnd].filter((a) => a !== undefined);
  const content = (
    <>
      {icon ? <Icon name={icon} size={24} tone="secondary" /> : null}
      <View style={{ flex: 1, gap: theme.space["2"] }}>
        <Text>{title}</Text>
        {subtitle ? (
          <Text variant="text14" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ?? null}
    </>
  );
  const rowStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.space["12"],
    minHeight: theme.density.touchMin,
    paddingHorizontal: theme.space["16"],
    paddingVertical: theme.space["8"],
    backgroundColor: theme.color.bgCanvas,
  };
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{
        borderBottomWidth: theme.strokeWidth.hairline,
        borderBottomColor: theme.color.borderSubtle,
        overflow: "hidden",
      }}
    >
      {actions.length ? (
        <View
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingHorizontal: theme.space["16"],
            backgroundColor: theme.color.bgSurface,
          }}
        >
          {swipeStart ? (
            <IconInk
              name={swipeStart.icon}
              color={toneFill(theme, swipeStart.tone ?? "success").fill}
            />
          ) : (
            <View />
          )}
          {swipeEnd ? (
            <IconInk
              name={swipeEnd.icon}
              color={toneFill(theme, swipeEnd.tone ?? "warning").fill}
            />
          ) : null}
        </View>
      ) : null}
      <Animated.View
        {...responder.panHandlers}
        accessibilityActions={actions.map((a) => ({ name: a.label, label: a.label }))}
        onAccessibilityAction={(e: { nativeEvent: { actionName: string } }) =>
          actions.find((a) => a.label === e.nativeEvent.actionName)?.onAction()
        }
        style={{ transform: [{ translateX: offset }] }}
      >
        {onPress ? (
          <Pressable
            role="button"
            onPress={onPress}
            style={({ pressed }) => ({
              ...rowStyle,
              backgroundColor: pressed ? theme.color.bgHover : theme.color.bgCanvas,
            })}
          >
            {content}
          </Pressable>
        ) : (
          <View style={rowStyle}>{content}</View>
        )}
      </Animated.View>
    </View>
  );
}
