import { useId, useMemo, type ReactElement } from "react";
import { Pressable, Switch as RNSwitch, TextInput, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import qrcode from "qrcode-generator";
import { departmentIcon, isDepartmentCode } from "@xos/icons";
import { useHaptic, useTheme } from "../theme/index.ts";
import type {
  AvatarProps,
  CheckboxProps,
  DepartmentChipProps,
  MoneyProps,
  ProgressBarProps,
  QRCodeProps,
  SkeletonProps,
  SwitchProps,
  TextFieldProps,
} from "../types.ts";
import { Icon, IconInk, Ink, Text } from "./foundations.tsx";

const KEYBOARD = {
  default: "default",
  numeric: "numeric",
  decimal: "decimal-pad",
  email: "email-address",
  phone: "phone-pad",
  url: "url",
} as const;

/** A labeled text field with help and error text; the label and messages are tied to the input. */
export function TextField({
  label,
  value,
  onChangeText,
  help,
  error,
  keyboard = "default",
  secure = false,
  multiline = false,
  disabled = false,
  autoComplete,
  testID,
}: TextFieldProps): ReactElement {
  const theme = useTheme();
  const id = useId();
  const type = theme.typography.text16;
  /* Addresses and secrets are typed exactly: iOS must not capitalize or autocorrect them. */
  const literal = secure || keyboard === "email" || keyboard === "url";
  const contentType = secure
    ? "password"
    : keyboard === "email"
      ? "emailAddress"
      : keyboard === "url"
        ? "URL"
        : undefined;
  return (
    <View style={{ gap: theme.space["6"] }}>
      <Text variant="label13">{label}</Text>
      <TextInput
        nativeID={id}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-disabled={disabled || undefined}
        {...(testID === undefined ? {} : { testID })}
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        multiline={multiline}
        secureTextEntry={secure}
        keyboardType={KEYBOARD[keyboard]}
        {...(literal ? { autoCapitalize: "none", autoCorrect: false, spellCheck: false } : {})}
        {...(autoComplete ? { autoComplete } : {})}
        {...(contentType ? { textContentType: contentType } : {})}
        style={{
          minHeight: multiline ? theme.density.touchMin * 2 : theme.density.touchMin,
          paddingHorizontal: theme.space["12"],
          paddingVertical: theme.space["8"],
          borderRadius: theme.radius.control,
          borderWidth: theme.controlBorderWidth,
          borderColor: error ? theme.color.danger : theme.color.borderControl,
          backgroundColor: theme.color.bgSurface,
          color: theme.color.textPrimary,
          fontFamily: type.fontFamily,
          fontSize: type.fontSize,
          opacity: disabled ? theme.opacity.disabled : 1,
        }}
      />
      {error ? (
        <Text variant="text14" tone="danger">
          {error}
        </Text>
      ) : help ? (
        <Text variant="text14" tone="secondary">
          {help}
        </Text>
      ) : null}
    </View>
  );
}

/** A checkbox with its label; the whole row is the 48 pt target. */
export function Checkbox({
  label,
  checked,
  onChange,
  disabled = false,
  testID,
}: CheckboxProps): ReactElement {
  const theme = useTheme();
  const haptic = useHaptic();
  const box = theme.space["24"];
  return (
    <Pressable
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      {...(testID === undefined ? {} : { testID })}
      onPress={() => {
        haptic("selection");
        onChange(!checked);
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space["12"],
        minHeight: theme.density.touchMin,
        opacity: disabled ? theme.opacity.disabled : 1,
      }}
    >
      <View
        style={{
          width: box,
          height: box,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.chip,
          borderWidth: theme.controlBorderWidth,
          borderColor: checked ? theme.color.accentDefault : theme.color.borderControl,
          backgroundColor: checked ? theme.color.accentDefault : theme.color.bgSurface,
        }}
      >
        {checked ? <IconInk name="Check" size={20} color={theme.color.accentTextOn} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text>{label}</Text>
      </View>
    </Pressable>
  );
}

/** An immediate on or off setting on the platform switch, with optional help. */
export function Switch({
  label,
  value,
  onChange,
  help,
  disabled = false,
  testID,
}: SwitchProps): ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space["12"],
        minHeight: theme.density.touchMin,
      }}
    >
      <View style={{ flex: 1, gap: theme.space["2"] }}>
        <Text>{label}</Text>
        {help ? (
          <Text variant="text14" tone="secondary">
            {help}
          </Text>
        ) : null}
      </View>
      <RNSwitch
        aria-label={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        {...(testID === undefined ? {} : { testID })}
        trackColor={{ false: theme.color.borderControl, true: theme.color.accentDefault }}
        thumbColor={theme.color.bgRaised}
      />
    </View>
  );
}

/** Money in integer minor units; null renders the unpriced label, never zero. */
export function Money({
  amount,
  currency = "USD",
  unpricedLabel,
  testID,
}: MoneyProps): ReactElement {
  if (amount === null) {
    return (
      <Text tone="secondary" {...(testID === undefined ? {} : { testID })}>
        {unpricedLabel}
      </Text>
    );
  }
  const format = new Intl.NumberFormat(undefined, { style: "currency", currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return (
    <Text {...(testID === undefined ? {} : { testID })}>
      {format.format(amount / 10 ** digits)}
    </Text>
  );
}

/** A person's initials in a circle; the name is the accessible label. */
export function Avatar({ name, size = "md", testID }: AvatarProps): ReactElement {
  const theme = useTheme();
  const dim = size === "lg" ? theme.density.touchMin : theme.space["32"];
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
  return (
    <View
      role="img"
      aria-label={name}
      {...(testID === undefined ? {} : { testID })}
      style={{
        width: dim,
        height: dim,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: theme.radius.pill,
        backgroundColor: theme.color.bgHover,
      }}
    >
      <Text variant="label13">{initials}</Text>
    </View>
  );
}

/** Determinate progress, 0 to 100. */
export function ProgressBar({ label, value, valueLabel, testID }: ProgressBarProps): ReactElement {
  const theme = useTheme();
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <View style={{ gap: theme.space["4"] }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text variant="text14" tone="secondary">
          {label}
        </Text>
        <Text variant="text14" tone="secondary">
          {valueLabel ??
            new Intl.NumberFormat(undefined, { style: "percent" }).format(percent / 100)}
        </Text>
      </View>
      <View
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        {...(testID === undefined ? {} : { testID })}
        style={{
          height: theme.space["4"],
          borderRadius: theme.radius.pill,
          overflow: "hidden",
          backgroundColor: theme.color.bgHover,
        }}
      >
        <View
          style={{
            width: `${percent}%`,
            height: "100%",
            backgroundColor: theme.color.accentDefault,
          }}
        />
      </View>
    </View>
  );
}

/** A loading block, or stacked lines standing in for text; hidden from assistive technology. */
export function Skeleton({
  width = "100%",
  height,
  lines = 1,
  testID,
}: SkeletonProps): ReactElement {
  const theme = useTheme();
  const line = height ?? theme.space["12"];
  return (
    <View
      aria-hidden
      {...(testID === undefined ? {} : { testID })}
      style={{ gap: theme.space["6"] }}
    >
      {Array.from({ length: lines }, (_, i) => (
        <View
          key={i}
          style={{
            width: i === lines - 1 && lines > 1 ? "60%" : width,
            height: line,
            borderRadius: theme.radius.chip,
            backgroundColor: theme.color.bgHover,
          }}
        />
      ))}
    </View>
  );
}

interface QRModules {
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

/** A scannable code, always dark on a light quiet zone so scanners read it in every theme. */
export function QRCode({ value, label, size = 200, testID }: QRCodeProps): ReactElement {
  const theme = useTheme();
  const { modules, path } = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value);
    code.make();
    const grid = code as unknown as QRModules;
    const n = grid.getModuleCount();
    const cells: string[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (grid.isDark(r, c)) cells.push(`M${c + 4} ${r + 4}h1v1h-1z`);
    }
    return { modules: n + 8, path: cells.join("") };
  }, [value]);
  return (
    <Svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      {...(testID === undefined ? {} : { testID })}
    >
      <Rect width={modules} height={modules} fill={theme.color.paper} />
      <Path d={path} fill={theme.color.paperInk} />
    </Svg>
  );
}

/** A department with its canon glyph; the code is never shown alone. */
export function DepartmentChip({ code, name, testID }: DepartmentChipProps): ReactElement {
  const theme = useTheme();
  return (
    <View
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
      <Icon
        name={isDepartmentCode(code) ? departmentIcon(code) : "Circle"}
        size={20}
        tone="secondary"
      />
      <Ink variant="label13" color={theme.color.textPrimary}>
        {name}
      </Ink>
    </View>
  );
}
