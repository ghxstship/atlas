import type { ReactElement } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useReducedMotion } from "../a11y.ts";
import { useHaptic, useTheme } from "../theme/index.ts";
import type { SheetProps, TabBarProps } from "../types.ts";
import { Badge } from "./data.tsx";
import { IconInk, Ink, Text } from "./foundations.tsx";
import { IconButton } from "./primitives.tsx";

/**
 * A bottom sheet over a scrim. The scrim and the close button dismiss it; the content scrolls and
 * the footer stays pinned. Opens at the first snap point (half the screen by default).
 */
export function Sheet({
  open,
  title,
  onClose,
  closeLabel,
  snapPoints = [0.5, 0.92],
  footer,
  children,
  testID,
}: SheetProps): ReactElement {
  const theme = useTheme();
  const height = `${Math.round((snapPoints[0] ?? 0.5) * 100)}%` as const;
  const still = useReducedMotion();
  return (
    <Modal
      visible={open}
      transparent
      animationType={still ? "fade" : "slide"}
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          aria-label={closeLabel}
          role="button"
          onPress={onClose}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: theme.color.scrim,
            opacity: theme.dark ? theme.opacity.scrimDark : theme.opacity.scrimLight,
          }}
        />
        <View
          role="dialog"
          aria-modal
          aria-label={title}
          {...(testID === undefined ? {} : { testID })}
          style={{
            minHeight: height,
            maxHeight: `${Math.round((snapPoints[snapPoints.length - 1] ?? 0.92) * 100)}%`,
            gap: theme.space["16"],
            paddingTop: theme.space["8"],
            paddingHorizontal: theme.space["16"],
            paddingBottom: theme.space["24"],
            borderTopLeftRadius: theme.radius.dialog,
            borderTopRightRadius: theme.radius.dialog,
            backgroundColor: theme.color.bgRaised,
            boxShadow: theme.shadow.dialog,
          }}
        >
          <View
            aria-hidden
            style={{
              alignSelf: "center",
              width: theme.space["32"] + theme.space["4"],
              height: theme.space["4"] + theme.strokeWidth.hairline,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.color.borderStrong,
            }}
          />
          <View
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <Text variant="heading20" heading>
              {title}
            </Text>
            <IconButton icon="X" label={closeLabel} onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={{ gap: theme.space["16"] }}>{children}</ScrollView>
          {footer ? <View style={{ gap: theme.space["8"] }}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

/** The Compass bottom bar: up to five destinations with an optional raised center action (Scan). */
export function TabBar({
  label,
  items,
  active,
  onSelect,
  center,
  testID,
}: TabBarProps): ReactElement {
  const theme = useTheme();
  const haptic = useHaptic();
  const half = Math.ceil(items.length / 2);
  const tab = (item: TabBarProps["items"][number]) => {
    const on = item.key === active;
    const color = on ? theme.color.accentText : theme.color.textSecondary;
    return (
      <Pressable
        key={item.key}
        role="tab"
        aria-selected={on}
        aria-label={item.badge ? `${item.label}, ${item.badge}` : item.label}
        onPress={() => {
          if (!on) haptic("selection");
          onSelect(item.key);
        }}
        style={{
          flex: 1,
          minHeight: theme.density.touchMin,
          alignItems: "center",
          justifyContent: "center",
          gap: theme.space["2"],
        }}
      >
        <View>
          <IconInk name={item.icon} size={24} color={color} />
          {item.badge ? (
            <View
              style={{ position: "absolute", top: -theme.space["6"], right: -theme.space["12"] }}
            >
              <Badge count={item.badge} tone="danger" />
            </View>
          ) : null}
        </View>
        <Ink variant="text11" color={color}>
          {item.label}
        </Ink>
      </Pressable>
    );
  };
  return (
    <View
      role="tablist"
      aria-label={label}
      {...(testID === undefined ? {} : { testID })}
      style={{
        flexDirection: "row",
        alignItems: "stretch",
        paddingTop: theme.space["6"],
        paddingBottom: theme.space["20"],
        borderTopWidth: theme.strokeWidth.hairline,
        borderTopColor: theme.color.borderSubtle,
        backgroundColor: theme.color.bgSurface,
      }}
    >
      {items.slice(0, center ? half : items.length).map(tab)}
      {center ? (
        <Pressable
          role="tab"
          aria-selected={false}
          aria-label={center.label}
          onPress={() => {
            haptic("impact");
            center.onPress();
          }}
          style={{ flex: 1, alignItems: "center", gap: theme.space["2"] }}
        >
          <View
            style={{
              marginTop: -theme.space["20"],
              width: theme.density.touchMin + theme.space["8"],
              height: theme.density.touchMin + theme.space["8"],
              alignItems: "center",
              justifyContent: "center",
              borderRadius: theme.radius.pill,
              borderWidth: theme.space["4"],
              borderColor: theme.color.bgSurface,
              backgroundColor: theme.color.accentDefault,
            }}
          >
            <IconInk name={center.icon} size={28} color={theme.color.accentTextOn} />
          </View>
          <Ink variant="text11" color={theme.color.textSecondary}>
            {center.label}
          </Ink>
        </Pressable>
      ) : null}
      {center ? items.slice(half).map(tab) : null}
    </View>
  );
}
