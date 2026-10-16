/**
 * Test-only DOM renderer for the React Native primitives @xos/ui-native uses, so components render
 * in jsdom under Testing Library and axe. It forwards the props that carry behavior and semantics
 * (role, aria-*, testID, onPress, text input) and drops layout styles, which the native component
 * gallery and device screenshots verify instead.
 */
import { createElement, type KeyboardEvent, type ReactNode } from "react";

interface AnyProps {
  children?: ReactNode;
  role?: unknown;
  nativeID?: unknown;
  disabled?: unknown;
  onPress?: unknown;
  onLongPress?: unknown;
  onChangeText?: unknown;
  multiline?: unknown;
  value?: unknown;
  editable?: unknown;
  visible?: unknown;
  accessibilityActions?: unknown;
  onAccessibilityAction?: unknown;
  [key: string]: unknown;
}

function semantic(props: AnyProps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "role")
      out["role"] = value === "header" ? "heading" : value === "summary" ? "group" : value;
    else if (key.startsWith("aria-")) out[key] = value;
    else if (key === "testID") out["data-testid"] = value;
    else if (key === "nativeID") out["id"] = value;
  }
  if (out["role"] === "heading" && out["aria-level"] === undefined) out["aria-level"] = 2;
  if (out["role"] === undefined && out["aria-label"] !== undefined) out["role"] = "group";
  return out;
}

function press(props: AnyProps): Record<string, unknown> {
  const disabled = props.disabled === true || props["aria-disabled"] === true;
  const onPress = props.onPress as (() => void) | undefined;
  const onLongPress = props.onLongPress as (() => void) | undefined;
  return {
    tabIndex: disabled ? -1 : 0,
    onClick: disabled ? undefined : () => onPress?.(),
    onContextMenu: onLongPress ? () => onLongPress() : undefined,
    onKeyDown: (e: KeyboardEvent) => {
      if (!disabled && (e.key === "Enter" || e.key === " ")) onPress?.();
    },
  };
}

export function View(props: AnyProps) {
  return createElement("div", semantic(props), props.children);
}

export function ScrollView(props: AnyProps) {
  return createElement(
    "div",
    semantic(props),
    props["refreshControl"] as ReactNode,
    props.children,
  );
}

export function Text(props: AnyProps) {
  return createElement("span", semantic(props), props.children);
}

export function Pressable(props: AnyProps) {
  const children =
    typeof props.children === "function"
      ? (props.children as (s: { pressed: boolean }) => ReactNode)({ pressed: false })
      : props.children;
  return createElement("div", { ...semantic(props), ...press(props) }, children);
}

export function TextInput(props: AnyProps) {
  const onChangeText = props.onChangeText as ((v: string) => void) | undefined;
  return createElement(props.multiline ? "textarea" : "input", {
    ...semantic(props),
    value: props.value,
    readOnly: props.editable === false,
    onChange: (e: { target: { value: string } }) => onChangeText?.(e.target.value),
  });
}

export function ActivityIndicator(props: AnyProps) {
  return createElement("span", { ...semantic(props), role: "progressbar" });
}

export function Switch(props: AnyProps) {
  const onValueChange = props["onValueChange"] as ((v: boolean) => void) | undefined;
  return createElement("input", {
    ...semantic(props),
    type: "checkbox",
    role: "switch",
    checked: props.value === true,
    disabled: props.disabled === true,
    onChange: () => onValueChange?.(props.value !== true),
  });
}

export function RefreshControl(props: AnyProps) {
  const onRefresh = props["onRefresh"] as (() => void) | undefined;
  return createElement(
    "button",
    { type: "button", "data-refresh": true, onClick: () => onRefresh?.() },
    "refresh",
  );
}

export function Modal(props: AnyProps) {
  return props.visible
    ? createElement(
        "div",
        { ...semantic(props), "data-animation": props["animationType"] },
        props.children,
      )
    : null;
}

class AnimatedValue {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  setValue(value: number): void {
    this.value = value;
  }
}

/* Custom accessibility actions render as buttons so tests reach them the way VoiceOver does. */
function AnimatedView(props: AnyProps) {
  const actions =
    (props.accessibilityActions as { name: string; label: string }[] | undefined) ?? [];
  const run = props.onAccessibilityAction as
    ((e: { nativeEvent: { actionName: string } }) => void) | undefined;
  return createElement(
    "div",
    semantic(props),
    props.children,
    actions.map((a) =>
      createElement(
        "button",
        {
          key: a.name,
          type: "button",
          "data-accessibility-action": a.name,
          onClick: () => run?.({ nativeEvent: { actionName: a.name } }),
        },
        a.label,
      ),
    ),
  );
}

export const Animated = {
  View: AnimatedView,
  Value: AnimatedValue,
  timing: (value: AnimatedValue, config: { toValue: number }) => ({
    start: () => value.setValue(config.toValue),
  }),
};

export const PanResponder = {
  create: (config: Record<string, unknown>) => ({ panHandlers: {}, config }),
};

export const StyleSheet = {
  create<T>(styles: T): T {
    return styles;
  },
  hairlineWidth: 1,
  absoluteFill: {},
};

export const Platform = {
  OS: "ios",
  select: <T,>(o: { ios?: T; default?: T }) => o.ios ?? o.default,
};

export const Vibration = { vibrate: () => undefined };

const reduceMotionListeners = new Set<(on: boolean) => void>();
let reduceMotionSetting = false;

export const AccessibilityInfo = {
  announceForAccessibility: () => undefined,
  isReduceMotionEnabled: () => Promise.resolve(reduceMotionSetting),
  addEventListener: (event: string, handler: (on: boolean) => void) => {
    if (event === "reduceMotionChanged") reduceMotionListeners.add(handler);
    return { remove: () => reduceMotionListeners.delete(handler) };
  },
};

/** Test control: flips the system Reduce Motion setting and fires its change event. */
export function setReduceMotionForTest(on: boolean): void {
  reduceMotionSetting = on;
  for (const listener of reduceMotionListeners) listener(on);
}
