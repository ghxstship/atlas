import type { ReactElement } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useHaptic, useTheme, type XosNativeTheme } from "../theme/index.ts";
import type { ButtonProps, IconButtonProps, SegmentedControlProps } from "../types.ts";
import { Icon, IconInk, Ink, Text } from "./foundations.tsx";

type Variant = NonNullable<ButtonProps["variant"]>;

function palette(theme: XosNativeTheme, variant: Variant) {
  switch (variant) {
    case "primary":
      return { bg: theme.color.accentDefault, fg: theme.color.accentTextOn, border: "transparent" };
    case "danger":
      return { bg: theme.color.danger, fg: theme.color.dangerTextOn, border: "transparent" };
    case "ghost":
      return { bg: "transparent", fg: theme.color.textPrimary, border: "transparent" };
    default:
      return {
        bg: theme.color.bgRaised,
        fg: theme.color.textPrimary,
        border: theme.color.borderControl,
      };
  }
}

/**
 * One action. md meets the 48 pt Compass target; lg is the 56 pt thumb button. With
 * `holdToConfirm`, a tap does nothing and the action fires only after the hold.
 */
export function Button({
  label,
  onPress,
  variant = "secondary",
  size = "md",
  icon,
  disabled = false,
  loading = false,
  block = false,
  holdToConfirm,
  testID,
}: ButtonProps): ReactElement {
  const theme = useTheme();
  const haptic = useHaptic();
  const colors = palette(theme, variant);
  const inert = disabled || loading;
  const fire = () => {
    haptic(holdToConfirm ? "warning" : "impact");
    onPress?.();
  };
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      {...(holdToConfirm ? { accessibilityHint: holdToConfirm.hint } : {})}
      {...(testID === undefined ? {} : { testID })}
      disabled={inert}
      {...(holdToConfirm
        ? { onLongPress: fire, delayLongPress: holdToConfirm.seconds * 1000 }
        : { onPress: fire })}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space["8"],
        alignSelf: block ? "stretch" : "flex-start",
        minHeight:
          size === "lg" ? theme.density.touchMin + theme.space["8"] : theme.density.touchMin,
        paddingHorizontal: theme.space["16"],
        borderRadius: theme.radius.control,
        borderWidth: colors.border === "transparent" ? 0 : theme.controlBorderWidth,
        borderColor: colors.border,
        backgroundColor: pressed && variant !== "primary" ? theme.color.bgHover : colors.bg,
        opacity: inert ? theme.opacity.disabled : pressed ? 1 - theme.opacity.pressed : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={colors.fg} aria-hidden />
      ) : icon ? (
        <IconInk name={icon} size={20} color={colors.fg} />
      ) : null}
      <Ink variant={size === "lg" ? "heading16" : "label13"} color={colors.fg}>
        {label}
      </Ink>
    </Pressable>
  );
}

/** A square 48 pt control with one icon; `label` is required and becomes the accessible name. */
export function IconButton({
  icon,
  label,
  onPress,
  variant = "ghost",
  disabled = false,
  testID,
}: IconButtonProps): ReactElement {
  const theme = useTheme();
  const colors = palette(theme, variant);
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      {...(onPress ? { onPress } : {})}
      {...(testID === undefined ? {} : { testID })}
      hitSlop={theme.space["4"]}
      style={({ pressed }) => ({
        width: theme.density.touchMin,
        height: theme.density.touchMin,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: theme.radius.control,
        borderWidth: variant === "secondary" ? theme.controlBorderWidth : 0,
        borderColor: colors.border,
        backgroundColor: pressed ? theme.color.bgHover : colors.bg,
        opacity: disabled ? theme.opacity.disabled : 1,
      })}
    >
      <Icon name={icon} size={24} />
    </Pressable>
  );
}

/** A single-choice switch between two to four options, each a 48 pt target. */
export function SegmentedControl({
  label,
  value,
  options,
  onChange,
  testID,
}: SegmentedControlProps): ReactElement {
  const theme = useTheme();
  const haptic = useHaptic();
  return (
    <View
      role="radiogroup"
      aria-label={label}
      {...(testID === undefined ? {} : { testID })}
      style={{
        flexDirection: "row",
        alignSelf: "stretch",
        gap: theme.space["2"],
        padding: theme.space["2"],
        borderRadius: theme.radius.control,
        borderWidth: theme.controlBorderWidth,
        borderColor: theme.color.borderControl,
        backgroundColor: theme.color.bgSurface,
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            role="radio"
            aria-checked={on}
            aria-label={o.label}
            onPress={() => {
              if (on) return;
              haptic("selection");
              onChange(o.value);
            }}
            style={{
              flex: 1,
              flexDirection: "row",
              gap: theme.space["6"],
              minHeight: theme.density.touchMin - theme.space["8"],
              alignItems: "center",
              justifyContent: "center",
              borderRadius: theme.radius.chip,
              backgroundColor: on ? theme.color.bgRaised : "transparent",
            }}
          >
            {o.icon ? <Icon name={o.icon} size={20} /> : null}
            <Text variant="label13" tone={on ? "primary" : "secondary"}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
