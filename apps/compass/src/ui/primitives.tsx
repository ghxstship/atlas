/**
 * Foundations and primitives for the @xos/ui-native seam: Text, Icon, Button, IconButton, TextField,
 * Switch and SegmentedControl, with the ui-native names and props. Every value comes from the theme.
 * Touch targets are at least 48 pt (Section 4.3) and grow with hit slop for gloves.
 */
import type {
  ButtonProps,
  IconButtonProps,
  IconProps,
  SegmentedControlProps,
  SwitchProps,
  TextFieldProps,
  TextProps,
} from "@xos/ui-native";
import { useReducedMotion } from "@xos/ui-native";
import { useHaptic, useTheme, type XosNativeTheme } from "@xos/ui-native/theme";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  Switch as NativeSwitch,
  Text as NativeText,
  TextInput,
  View,
  type TextStyle,
} from "react-native";
import { ICONS } from "./icons";

type Tone = NonNullable<TextProps["tone"]>;

export function toneColor(theme: XosNativeTheme, tone: Tone): string {
  switch (tone) {
    case "primary":
      return theme.color.textPrimary;
    case "secondary":
      return theme.color.textSecondary;
    case "tertiary":
      return theme.color.textTertiary;
    case "accent":
      return theme.color.accentText;
    case "success":
      return theme.color.successText;
    case "warning":
      return theme.color.warningText;
    case "danger":
      return theme.color.dangerText;
  }
}

export function typography(
  theme: XosNativeTheme,
  variant: NonNullable<TextProps["variant"]>,
): TextStyle {
  const t = theme.typography[variant];
  return { fontSize: t.fontSize, lineHeight: t.lineHeight, fontWeight: t.fontWeight };
}

export function Text({
  variant = "text16",
  tone = "primary",
  numberOfLines,
  heading,
  children,
  testID,
}: TextProps): ReactElement {
  const theme = useTheme();
  return (
    <NativeText
      testID={testID}
      accessibilityRole={heading ? "header" : "text"}
      numberOfLines={numberOfLines}
      maxFontSizeMultiplier={2}
      style={[
        typography(theme, variant),
        { color: toneColor(theme, tone) },
        variant === "mono13" ? { fontFamily: "Menlo" } : null,
      ]}
    >
      {children}
    </NativeText>
  );
}

/** A test id prop object, so optional ids never pass `undefined` under exactOptionalPropertyTypes. */
export function tid(base: string | undefined, suffix?: string): { testID?: string } {
  if (base === undefined) return {};
  return { testID: suffix ? `${base}-${suffix}` : base };
}

export function Icon({
  name,
  size = 24,
  label,
  tone = "primary",
  onAccent = false,
  testID,
}: IconProps & {
  /** Drawn on an accent fill (the raised Scan tab), so it uses the on-accent color. */
  onAccent?: boolean;
}): ReactElement | null {
  const theme = useTheme();
  const Glyph = ICONS[name];
  if (!Glyph) return null;
  return (
    <View
      testID={testID}
      accessible={label !== undefined}
      accessibilityLabel={label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
    >
      <Glyph
        size={size}
        color={onAccent ? theme.color.accentTextOn : toneColor(theme, tone)}
        strokeWidth={theme.strokeWidth.focus}
      />
    </View>
  );
}

/** Generous hit slop for gloved hands: the visible control stays tidy, the target grows. */
export function gloveSlop(theme: XosNativeTheme) {
  const s = theme.space["8"];
  return { top: s, bottom: s, left: s, right: s };
}

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  icon,
  disabled,
  loading,
  block,
  holdToConfirm,
  testID,
}: ButtonProps): ReactElement {
  const theme = useTheme();
  // Plays only while the person keeps haptics on: Compass gives ThemeProvider a handler then (me.haptics).
  const haptic = useHaptic();
  const progress = useRef(new Animated.Value(0)).current;
  const [holding, setHolding] = useState(false);
  // Reduce Motion (A23-008): the hold counts down whole seconds instead of animating a fill.
  const still = useReducedMotion();
  const [remaining, setRemaining] = useState<number | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTick = () => {
    if (tick.current !== null) clearInterval(tick.current);
    tick.current = null;
    setRemaining(null);
  };
  useEffect(() => stopTick, []);
  const background = {
    primary: theme.color.accentDefault,
    secondary: theme.color.bgRaised,
    ghost: "transparent",
    danger: theme.color.danger,
  }[variant];
  const foreground = {
    primary: theme.color.accentTextOn,
    secondary: theme.color.textPrimary,
    ghost: theme.color.accentText,
    danger: theme.color.dangerTextOn,
  }[variant];
  const minHeight = size === "lg" ? theme.space["48"] + theme.space["8"] : theme.density.touchMin;
  const fire = () => {
    haptic("impact");
    onPress?.();
  };
  const startHold = () => {
    if (!holdToConfirm) return;
    setHolding(true);
    if (still) {
      let left = Math.max(1, Math.ceil(holdToConfirm.seconds));
      setRemaining(left);
      tick.current = setInterval(() => {
        left -= 1;
        if (left > 0) {
          setRemaining(left);
          return;
        }
        stopTick();
        setHolding(false);
        haptic("warning");
        onPress?.();
      }, 1000);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: holdToConfirm.seconds * 1000,
      useNativeDriver: false,
    }).start(({ finished }) => {
      setHolding(false);
      progress.setValue(0);
      if (finished) {
        haptic("warning");
        onPress?.();
      }
    });
  };
  const endHold = () => {
    if (!holdToConfirm) return;
    stopTick();
    progress.stopAnimation();
    progress.setValue(0);
    setHolding(false);
  };
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={holdToConfirm?.hint}
      accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(loading) }}
      accessibilityActions={holdToConfirm ? [{ name: "activate" }] : undefined}
      onAccessibilityAction={holdToConfirm ? () => onPress?.() : undefined}
      disabled={disabled || loading}
      hitSlop={gloveSlop(theme)}
      onPress={holdToConfirm ? undefined : fire}
      onPressIn={startHold}
      onPressOut={endHold}
      style={({ pressed }) => ({
        minHeight,
        // A text button that is not full width lines its label up with the content edge, as on iOS
        // (finding A59-031: "Use Password" sat 16 pt in from every other element); gloveSlop keeps its target.
        paddingHorizontal: variant === "ghost" && !block ? 0 : theme.space["20"],
        borderRadius: theme.radius.control,
        backgroundColor: background,
        borderWidth: variant === "secondary" ? theme.controlBorderWidth : 0,
        borderColor: theme.color.borderControl,
        opacity: disabled ? theme.opacity.disabled : pressed ? 1 - theme.opacity.pressed : 1,
        alignSelf: block ? "stretch" : "flex-start",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: theme.space["8"],
        overflow: "hidden",
      })}
    >
      {holdToConfirm && !still ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            backgroundColor: theme.color.scrim,
            opacity: theme.opacity.scrimLight,
            width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
          }}
        />
      ) : null}
      {loading ? <ActivityIndicator color={foreground} /> : null}
      {icon && !loading ? (
        <Icon name={icon} size={20} tone={variant === "ghost" ? "accent" : "primary"} />
      ) : null}
      <NativeText
        maxFontSizeMultiplier={2}
        style={[
          typography(theme, size === "lg" ? "heading20" : "heading16"),
          { color: foreground },
        ]}
      >
        {holding && holdToConfirm
          ? remaining !== null
            ? `${holdToConfirm.hint} · ${remaining}`
            : holdToConfirm.hint
          : label}
      </NativeText>
    </Pressable>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  variant = "ghost",
  disabled,
  testID,
}: IconButtonProps): ReactElement {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={gloveSlop(theme)}
      style={{
        minWidth: theme.density.touchMin,
        minHeight: theme.density.touchMin,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: theme.radius.control,
        backgroundColor: variant === "secondary" ? theme.color.bgRaised : "transparent",
        opacity: disabled ? theme.opacity.disabled : 1,
      }}
    >
      <Icon name={icon} />
    </Pressable>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  help,
  error,
  keyboard = "default",
  secure,
  multiline,
  disabled,
  autoComplete,
  testID,
}: TextFieldProps): ReactElement {
  const theme = useTheme();
  const keyboardType = {
    default: "default",
    numeric: "number-pad",
    email: "email-address",
    phone: "phone-pad",
    url: "url",
  } as const;
  /* Addresses, codes and secrets are typed exactly: iOS must not capitalize or autocorrect them. A field
     with autofill off (a scanned code typed by hand) is literal too. */
  const literal =
    secure ||
    keyboard === "email" ||
    keyboard === "url" ||
    autoComplete === "one-time-code" ||
    autoComplete === "off";
  const contentType = secure
    ? "password"
    : keyboard === "email"
      ? "emailAddress"
      : keyboard === "url"
        ? "URL"
        : autoComplete === "one-time-code"
          ? "oneTimeCode"
          : undefined;
  return (
    <View style={{ gap: theme.space["6"] }}>
      <Text variant="label13" tone="secondary">
        {label}
      </Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={error ?? help}
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        secureTextEntry={secure}
        multiline={multiline}
        keyboardType={keyboardType[keyboard]}
        autoComplete={autoComplete === "one-time-code" ? "one-time-code" : autoComplete}
        {...(literal ? { autoCapitalize: "none", autoCorrect: false, spellCheck: false } : {})}
        {...(contentType ? { textContentType: contentType } : {})}
        maxFontSizeMultiplier={2}
        style={[
          typography(theme, "text16"),
          {
            minHeight: multiline ? theme.space["64"] + theme.space["32"] : theme.density.touchMin,
            paddingHorizontal: theme.space["12"],
            paddingVertical: theme.space["8"],
            borderRadius: theme.radius.control,
            borderWidth: theme.controlBorderWidth,
            borderColor: error ? theme.color.danger : theme.color.borderControl,
            backgroundColor: theme.color.bgSurface,
            color: theme.color.textPrimary,
            textAlignVertical: multiline ? "top" : "center",
          },
        ]}
      />
      {error ? (
        <Text variant="text13" tone="danger">
          {error}
        </Text>
      ) : help ? (
        <Text variant="text13" tone="tertiary">
          {help}
        </Text>
      ) : null}
    </View>
  );
}

export function Switch({
  label,
  value,
  onChange,
  help,
  disabled,
  testID,
}: SwitchProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: theme.density.touchMin,
        gap: theme.space["12"],
      }}
    >
      <View style={{ flex: 1, gap: theme.space["2"] }}>
        <Text>{label}</Text>
        {help ? (
          <Text variant="text13" tone="tertiary">
            {help}
          </Text>
        ) : null}
      </View>
      <NativeSwitch
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: theme.color.accentDefault, false: theme.color.borderStrong }}
      />
    </View>
  );
}

export function SegmentedControl({
  label,
  value,
  options,
  onChange,
  testID,
}: SegmentedControlProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space["8"] }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            hitSlop={gloveSlop(theme)}
            style={{
              minHeight: theme.density.touchMin,
              paddingHorizontal: theme.space["16"],
              borderRadius: theme.radius.pill,
              borderWidth: theme.controlBorderWidth,
              borderColor: selected ? theme.color.accentDefault : theme.color.borderControl,
              backgroundColor: selected ? theme.color.accentDefault : theme.color.bgSurface,
              flexDirection: "row",
              alignItems: "center",
              gap: theme.space["6"],
            }}
          >
            {option.icon ? <Icon name={option.icon} size={20} /> : null}
            <NativeText
              style={[
                typography(theme, "label13"),
                { color: selected ? theme.color.accentTextOn : theme.color.textPrimary },
              ]}
            >
              {option.label}
            </NativeText>
          </Pressable>
        );
      })}
    </View>
  );
}
